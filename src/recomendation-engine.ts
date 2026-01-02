import {
  and,
  cosineDistance,
  desc,
  eq,
  inArray,
  isNotNull,
  notInArray,
  sql,
} from "drizzle-orm";
import { db } from "./db";
import {
  likedSongsTable,
  skippedArtistsTable,
  trackTable,
} from "./schema";

// ---------- Updated Constants (Tuned for better flow) ----------

const penaltyGlobal = 0.05; // Slightly increased
const penaltyStreak = 0.08; 
const freeStreak = 1;      // Tightened: allow only 1 consecutive song
const temperature = 0.07;   // Lowered: makes recommendations more precise
const lambda = 0.85;       // Increased: favors relevance over forced diversity
const beta = 0.95;         // Increased: query stays truer to the current flow
const noiseScale = 0.005;   // Reduced: less "drifting" away from the vibe

// ---------- Optimized Utilities ----------

function l2norm(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

function softmaxSample(scores: number[], temperature = 0.1): number {
  const t = Math.max(1e-6, temperature);
  // Subtract max for numerical stability
  const maxScore = Math.max(...scores);
  const exps = scores.map((s) => Math.exp((s - maxScore) / t));
  const sum = exps.reduce((a, b) => a + b, 0);
  let r = Math.random() * sum;
  for (let i = 0; i < exps.length; i++) {
    r -= exps[i];
    if (r <= 0) return i;
  }
  return exps.length - 1;
}

function addNoiseNorm(v: number[], scale = 0.01): number[] {
  const out = v.slice();
  for (let i = 0; i < out.length; i++) {
    out[i] += (Math.random() * 2 - 1) * scale;
  }
  return l2norm(out);
}

// ---------- Types ----------

type RecommendOpts = {
  seedUris?: string[];
  limit?: number;
  annPool?: number;
  maxPerArtist?: number;
  excludeUris?: string[];
  alphaNow?: number; // Weight for seed vs liked
  clusterIds?: number[]; // Pre-filter by cluster
};

// ---------- Main Logic ----------

let cachedLikedCentroid: number[] | null = null;
let lastCentroidUpdate = 0;

export async function recommend(opts: RecommendOpts = {}) {
  const {
    seedUris = [],
    limit = 30,
    annPool = 1000,
    maxPerArtist = 2,
    excludeUris = [],
    alphaNow = 0.85,
    clusterIds = [],
  } = opts;

  // ... rest of logic

  // 1. SESSION RESET: Keep tracking internal to the function call
  const artistCounts = new Map<string, number>();
  let lastArtists: string[] = [];
  let streakLen = 0;

  function softArtistPenalty(artists: string[]): number {
    let globalCount = 0;
    for (const a of artists) globalCount += artistCounts.get(a) ?? 0;
    const shares = artists.some((a) => lastArtists.includes(a));
    const streakOver = Math.max(0, (shares ? streakLen : 0) - freeStreak);
    return penaltyGlobal * globalCount + penaltyStreak * streakOver;
  }

  // Set SQL seed for jitter consistency
  await db.execute(sql`SELECT setseed(${Math.random()})`);

  // 2. Efficiently fetch Skip Lists
  const skippedArtists = await db.select({ name: skippedArtistsTable.name }).from(skippedArtistsTable);
  const skipArtistSet = new Set(skippedArtists.map(x => x.name));

  // 3. Build Query Vector (q)
  if (!cachedLikedCentroid || Date.now() - lastCentroidUpdate > 1000 * 60 * 5) {
    const likedVecs = await getLikedEmbeddings();
    cachedLikedCentroid = centroidNormalized(likedVecs);
    lastCentroidUpdate = Date.now();
  }
  const c = cachedLikedCentroid;

  let s: number[] | null = null;
  if (seedUris.length) {
    const seeds = await getTracksByUris(seedUris);
    const seedVecs = seeds.map((t) => t.embedding).filter((e): e is number[] => Array.isArray(e));
    s = centroidNormalized(seedVecs);
  }

  let q: number[] | null = null;
  if (s && c) {
    q = l2norm(s.map((val, i) => alphaNow * val + (1 - alphaNow) * c[i]));
  } else {
    q = s || c || (await getRandomEmbedding());
  }

  if (!q) return [];

  // 4. Fetch Candidates (ANN Pool)
  const simFloor = 0.45;
  const similarity = sql<number>`1 - (${cosineDistance(trackTable.embedding, q)})`;
  
  const pool = await db
    .select({
      uri: trackTable.uri,
      name: trackTable.name,
      artists: trackTable.artist,
      album: trackTable.album,
      embedding: trackTable.embedding,
      similarity,
    })
    .from(trackTable)
    .where(
      and(
        isNotNull(trackTable.embedding),
        notInArray(trackTable.uri, [...excludeUris, ""]),
        sql<boolean>`${similarity} > ${simFloor}`,
        clusterIds.length > 0 ? inArray(trackTable.clusterId, clusterIds) : sql`TRUE`
      )
    )
    .orderBy(sql`(${similarity} + random() * 0.02) DESC`)
    .limit(annPool);

  // 5. Pre-normalize Pool and Filter Skips (Optimization)
  const poolN = pool
    .filter((p) => {
      if (!Array.isArray(p.embedding)) return false;
      return !p.artists.some(a => skipArtistSet.has(a));
    })
    .map((p) => ({
      ...p,
      normVec: l2norm(p.embedding as number[]),
      maxSimToSelected: -1 // Track max similarity to any selected song for MMR
    }));

  const selected: typeof poolN = [];

  // 6. MMR Selection Loop (Optimized to O(N * K))
  while (selected.length < limit && poolN.length) {
    const scores: number[] = [];
    const validIndices: number[] = [];

    for (let i = 0; i < poolN.length; i++) {
      const cand = poolN[i];

      const currentArtistCount = cand.artists.reduce((max, a) => 
        Math.max(max, artistCounts.get(a) ?? 0), 0);
      
      if (currentArtistCount >= maxPerArtist) continue;

      let rel = 0;
      for (let k = 0; k < q.length; k++) rel += cand.normVec[k] * q[k];

      const div = selected.length === 0 ? 0 : cand.maxSimToSelected;
      const mmrScore = lambda * rel - (1 - lambda) * div;
      const penalty = softArtistPenalty(cand.artists);
      
      scores.push(mmrScore - penalty);
      validIndices.push(i);
    }

    if (validIndices.length === 0) break;

    const selectedIdx = softmaxSample(scores, temperature);
    const poolIdx = validIndices[selectedIdx];
    const chosen = poolN.splice(poolIdx, 1)[0];

    selected.push(chosen);
    
    // Update maxSimToSelected for all remaining candidates in O(N)
    for (const cand of poolN) {
      let sim = 0;
      for (let k = 0; k < q.length; k++) sim += cand.normVec[k] * chosen.normVec[k];
      if (sim > cand.maxSimToSelected) cand.maxSimToSelected = sim;
    }

    for (const a of chosen.artists) {
      artistCounts.set(a, (artistCounts.get(a) ?? 0) + 1);
    }
    const shares = chosen.artists.some((a) => lastArtists.includes(a));
    streakLen = shares ? streakLen + 1 : 1;
    lastArtists = chosen.artists;

    // 7. Query Drift (Evolution)
    const drift = chosen.normVec;
    for (let i = 0; i < q.length; i++) {
      q[i] = beta * q[i] + (1 - beta) * drift[i];
    }
    q = addNoiseNorm(q, noiseScale);
  }

  return selected.map((t) => ({
    uri: t.uri,
    name: t.name,
    artists: t.artists,
    album: t.album,
    similarity: t.similarity,
  }));
}

// ---------- Helper implementation details ----------

async function getLikedEmbeddings(): Promise<number[][]> {
  const rows = await db
    .select({ embedding: trackTable.embedding })
    .from(likedSongsTable)
    .innerJoin(trackTable, eq(likedSongsTable.uri, trackTable.uri))
    .where(isNotNull(trackTable.embedding));
  return rows.map((r) => r.embedding as number[]);
}

async function getTracksByUris(uris: string[]) {
  if (!uris.length) return [];
  return db.select().from(trackTable).where(inArray(trackTable.uri, uris));
}

async function getRandomEmbedding(): Promise<number[] | null> {
  const [rnd] = await db
    .select({ embedding: trackTable.embedding })
    .from(trackTable)
    .where(isNotNull(trackTable.embedding))
    .orderBy(sql`random()`)
    .limit(1);
  return rnd?.embedding ? l2norm(rnd.embedding) : null;
}

function centroidNormalized(vecs: number[][]): number[] | null {
  if (!vecs.length) return null;
  const dim = vecs[0].length;
  const sum = new Array(dim).fill(0);
  for (const v of vecs) {
    for (let i = 0; i < dim; i++) sum[i] += v[i];
  }
  return l2norm(sum.map((s) => s / vecs.length));
}