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
  skippedSongsTable,
  trackTable,
} from "./schema";

// ---------- Christmas Filtering Helpers ----------

const christmasKeywords = [
  "christmas", "xmas", "santa", "noel", "mistletoe", "jingle", "sleigh", 
  "silent night", "deck the halls", "feliz navidad", "holiday jam", 
  "winter wonderland", "holly jolly", "drummer boy", "christmastime"
];

const falsePositiveSongs = ["carolina", "merrymaking at my place"];
const falsePositiveAlbums = ["breezy - it’s giving christmas"];

function isChristmasText(name: string, album: string): boolean {
  const nameLower = name.toLowerCase();
  const albumLower = album.toLowerCase();

  if (falsePositiveSongs.some(fp => nameLower.includes(fp)) || falsePositiveAlbums.some(fp => albumLower.includes(fp))) {
    return false;
  }

  return (
    christmasKeywords.some(kw => nameLower.includes(kw)) ||
    christmasKeywords.some(kw => albumLower.includes(kw))
  );
}

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
  excludeChristmas?: boolean; // Exclude Christmas tracks (defaults to true)
};

// ---------- Main Logic ----------

let cachedLikedCentroid: number[] | null = null;
let lastCentroidUpdate = 0;

export function invalidateLikedCache() {
  cachedLikedCentroid = null;
  lastCentroidUpdate = 0;
}

export async function recommend(opts: RecommendOpts = {}) {
  const {
    seedUris = [],
    limit = 30,
    annPool = 1000,
    maxPerArtist = 2,
    excludeUris = [],
    alphaNow = 0.85,
    clusterIds = [],
    excludeChristmas = true,
  } = opts;

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
  const [skippedArtists, skippedSongs] = await Promise.all([
    db.select({ name: skippedArtistsTable.name }).from(skippedArtistsTable),
    db.select({ uri: skippedSongsTable.uri }).from(skippedSongsTable)
  ]);
  const skipArtistSet = new Set(skippedArtists.map(x => x.name));
  const skipTrackSet = new Set(skippedSongs.map(x => x.uri));

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
      // Filter out skipped artists and tracks
      if (skipTrackSet.has(p.uri)) return false;
      if (p.artists.some(a => skipArtistSet.has(a))) return false;

      // Filter out Christmas tracks if requested
      if (excludeChristmas) {
        const isExplicit = isChristmasText(p.name, p.album);
        if (isExplicit) {
          return false;
        }
      }

      return true;
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

// ---------- URI Validation ----------

type TrackResult = {
  uri: string;
  name: string;
  artists: string[];
  album: string;
  similarity?: number;
};

function getMatchKey(name: string, artists: string[], album: string): string {
  const n = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\w\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const nName = n(name);
  const nAlbum = n(album);
  const nArtists = artists.map((a) => n(a)).sort().join("|");
  return `${nName}#${nArtists}#${nAlbum}`;
}

interface MATrack {
  uri: string;
  name: string;
  artists: { name: string }[];
  album: { name: string };
}

let cachedMAUris: Set<string> | null = null;
let cachedMANameMap: Map<string, string> | null = null; // matchKey → uri
let lastMAFetch = 0;
const MA_CACHE_MS = 5 * 60 * 1000;

async function fetchMALibrary(): Promise<{ uriSet: Set<string>; nameMap: Map<string, string> }> {
  const env = process.env;
  const authHeaders = new Headers();
  authHeaders.append("Content-Type", "application/json");
  authHeaders.append("Authorization", "Bearer " + env.TOKEN);

  const uriSet = new Set<string>();
  const nameMap = new Map<string, string>();
  let offset = 0;
  const BATCH = 500;

  while (true) {
    const raw = JSON.stringify({
      config_entry_id: env.CONFIG_ID,
      media_type: "track",
      limit: BATCH,
      offset,
      order_by: "sort_name",
    });

    const res = await fetch(
      env.HOST + "/api/services/music_assistant/get_library?return_response",
      { method: "POST", headers: authHeaders, body: raw, redirect: "follow" }
    );

    if (res.status !== 200) break;

    const data = await res.json();
    const items = data.service_response?.items;
    if (!items || items.length === 0) break;

    for (const t of items) {
      uriSet.add(t.uri);
      const key = getMatchKey(
        t.name,
        t.artists.map((a: any) => a.name),
        t.album.name
      );
      if (!nameMap.has(key)) {
        nameMap.set(key, t.uri);
      }
    }

    if (items.length < BATCH) break;
    offset += BATCH;
  }

  return { uriSet, nameMap };
}

async function getMALibrary(): Promise<{ uriSet: Set<string>; nameMap: Map<string, string> }> {
  if (!cachedMAUris || !cachedMANameMap || Date.now() - lastMAFetch > MA_CACHE_MS) {
    const lib = await fetchMALibrary();
    cachedMAUris = lib.uriSet;
    cachedMANameMap = lib.nameMap;
    lastMAFetch = Date.now();
    console.log(`[validate] MA library cache refreshed: ${lib.uriSet.size} tracks`);
  }
  return { uriSet: cachedMAUris, nameMap: cachedMANameMap };
}

export function invalidateMACache() {
  cachedMAUris = null;
  cachedMANameMap = null;
  lastMAFetch = 0;
}

export async function validateTrackUris(
  results: TrackResult[]
): Promise<TrackResult[]> {
  if (!results.length) return results;

  const { uriSet, nameMap } = await getMALibrary();

  const validated: TrackResult[] = [];
  let repaired = 0;
  let removed = 0;

  for (const t of results) {
    if (uriSet.has(t.uri)) {
      validated.push(t);
      continue;
    }

    const key = getMatchKey(t.name, t.artists, t.album);
    const maUri = nameMap.get(key);
    if (maUri) {
      console.log(`[validate] REPAIRED: ${t.uri} → ${maUri}  (${t.name})`);
      // Update DB to fix this URI permanently for next time
      db.update(trackTable).set({ uri: maUri }).where(eq(trackTable.uri, t.uri))
        .catch(() => {});
      validated.push({ ...t, uri: maUri });
      repaired++;
      continue;
    }

    console.log(`[validate] ORPHAN (not in MA library): ${t.uri}  (${t.name})`);
    removed++;
  }

  if (repaired > 0) console.log(`[validate] Repaired ${repaired} URIs`);
  if (removed > 0) console.log(`[validate] Removed ${removed} orphan tracks (not playable)`);

  return validated;
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