import {
    and,
    cosineDistance,
    desc,
    eq,
    inArray,
    isNotNull,
    notInArray,
    sql
} from "drizzle-orm";
import { db } from "./db";
import {
    likedSongsTable,
    skippedArtistsTable,
    skippedSongsTable,
    trackTable,
} from "./schema";

// ---------- Small utilities ----------

function l2norm(v: number[]): number[] {
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / n);
}
function dot(a: number[], b: number[]): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
}
function cosineSimNorm(a: number[], b: number[]): number {
    return dot(a, b); // assumes both are normalized
}
function centroidNormalized(vecs: number[][]): number[] | null {
    if (!vecs.length) return null;
    const dim = vecs[0].length;
    const sum = new Array(dim).fill(0);
    for (const v of vecs) {
        const n = l2norm(v);
        for (let i = 0; i < dim; i++) sum[i] += n[i];
    }
    for (let i = 0; i < dim; i++) sum[i] /= vecs.length;
    return l2norm(sum);
}

function softmaxSample(scores: number[], temperature = 0.1): number {
    const t = Math.max(1e-6, temperature);
    const exps = scores.map((s) => Math.exp(s / t));
    const sum = exps.reduce((a, b) => a + b, 0);
    let r = Math.random() * sum;
    for (let i = 0; i < exps.length; i++) {
        r -= exps[i];
        if (r <= 0) return i;
    }
    return exps.length - 1;
}

function addNoise(v: number[], scale = 0.02): number[] {
    const out = v.slice();
    for (let i = 0; i < out.length; i++) out[i] += (Math.random() * 2 - 1) * scale;
    return l2norm(out);
}

const penaltyGlobal = 0.03; // penalty per prior occurrence of any artist
const penaltyStreak = 0.06; // extra penalty per item beyond a free streak
const freeStreak = 2; // allow up to 2 consecutive songs before streak penalty
const useSoftmax = true; // if false, use epsilon-greedy/argmax mix
const temperature = 0.12; // softmax temperature (higher = more random)
const epsilon = 0.08; // epsilon-greedy chance to explore top-K
const topK = 30; // exploration pool size within top scores
const beta = 0.9; // query inertia for re-seeding (D)
const noiseScale = 0.01; // small query noise for re-seeding (D)

// Track global counts and current streak length
const artistCounts = new Map<string, number>();
let lastArtists: string[] = [];
let streakLen = 0;

function updateStreak(currentArtists: string[]) {
    const shares = currentArtists.some((a) => lastArtists.includes(a));
    streakLen = shares ? streakLen + 1 : 1;
    lastArtists = currentArtists;
}

function softArtistPenalty(artists: string[]): number {
    // Global part: sum counts of each artist seen so far
    let globalCount = 0;
    for (const a of artists) globalCount += artistCounts.get(a) ?? 0;

    // Streak part: only if we’re continuing the same-artist streak beyond freeStreak
    const shares = artists.some((a) => lastArtists.includes(a));
    const streakOver = Math.max(0, (shares ? streakLen : 0) - freeStreak);

    return penaltyGlobal * globalCount + penaltyStreak * streakOver;
}

function bumpArtistCounts(artists: string[]) {
    for (const a of artists) {
        artistCounts.set(a, (artistCounts.get(a) ?? 0) + 1);
    }
}

function addNoiseNorm(v: number[], scale = 0.01): number[] {
    const out = v.slice();
    for (let i = 0; i < out.length; i++) {
        out[i] += (Math.random() * 2 - 1) * scale;
    }
    // l2norm from your utilities
    return l2norm(out);
}

// ---------- Basic fetch helpers (ORM only) ----------

async function getTrackByUri(uri: string) {
    const [t] = await db
        .select({
            uri: trackTable.uri,
            name: trackTable.name,
            artists: trackTable.artists,
            album: trackTable.album,
            embedding: trackTable.embedding,
        })
        .from(trackTable)
        .where(eq(trackTable.uri, uri))
        .limit(1);

    return t;
}

async function getLikedEmbeddings(): Promise<number[][]> {
    const liked = await db
        .select({ uri: likedSongsTable.uri })
        .from(likedSongsTable);

    if (!liked.length) return [];

    const rows = await db
        .select({ embedding: trackTable.embedding })
        .from(trackTable)
        .where(inArray(trackTable.uri, liked.map((x) => x.uri)));

    return rows
        .map((r) => r.embedding)
        .filter((e): e is number[] => Array.isArray(e));
}

// If sql.array isn't available in your Drizzle version, replace the WHERE with
// inArray(trackTable.uri, urisChunk) in small chunks to avoid huge IN lists.

// ---------- Candidate generation using cosineDistance (ORM only) ----------

type Candidate = {
    uri: string;
    name: string;
    artists: string[];
    album: string;
    embedding: number[] | null;
    similarity: number;
    jitterScore: number;
};

async function annCandidatesByQueryEmbedding(
    q: number[],
    limit: number,
    excludeUris: string[] = [],
    opts?: { jitter?: number; simFloor?: number }
): Promise<Candidate[]> {
    const jitter = opts?.jitter ?? 0.02; // 2% noise
    const simFloor = opts?.simFloor ?? 0.55;

    const similarity = sql<number>`1 - (${cosineDistance(
        trackTable.embedding,
        q
    )})`;

    const jitterScore = sql<number>`${similarity} + (random() * ${jitter})`;

    const poolSize = Math.max(limit * 8, 600);

    const rows = await db
        .select({
            uri: trackTable.uri,
            name: trackTable.name,
            artists: trackTable.artists,
            album: trackTable.album,
            embedding: trackTable.embedding,
            similarity,
            jitterScore,
        })
        .from(trackTable)
        .where(
            and(
                isNotNull(trackTable.embedding),
                notInArray(trackTable.uri, excludeUris),
                sql<boolean>`NOT EXISTS (
          SELECT 1 FROM ${skippedArtistsTable} sa
          WHERE sa.name = ANY(${trackTable.artists})
        )`,
                sql<boolean>`NOT EXISTS (
          SELECT 1 FROM ${skippedSongsTable} ss
          WHERE ss.uri = ${trackTable.uri}
        )`,
                // similarity floor to keep results sane
                sql<boolean>`${similarity} > ${simFloor}`
            )
        )
        // Use jitterScore for ordering to induce randomness
        .orderBy((t) => desc(t.jitterScore))
        .limit(poolSize);

    return rows;
}

// Fetch multiple tracks by URI (ORM-only)
async function getTracksByUris(uris: string[]) {
    if (!uris.length) return [];
    // If you expect many URIs, you can chunk this to keep IN (...) reasonable.
    const rows = await db
        .select({
            uri: trackTable.uri,
            name: trackTable.name,
            artists: trackTable.artists,
            album: trackTable.album,
            embedding: trackTable.embedding,
        })
        .from(trackTable)
        .where(inArray(trackTable.uri, uris));
    return rows;
}

// ---------- Main recommend with MMR (ORM-only DB access) ----------

type RecommendOpts = {
    seedUris?: string[]; // current track
    limit?: number; // final number of recs
    annPool?: number; // pool size before MMR (optional override)
    lambda?: number; // MMR trade-off
    maxPerArtist?: number;
    excludeUris?: string[]; // recently played, etc.
    alphaNow?: number; // weight for seed vs. liked centroid
};

export async function recommend(opts: RecommendOpts = {}) {
    const {
        seedUris = [],
        limit = 30,
        annPool, // optional override
        lambda = 0.7,
        maxPerArtist = 2,
        excludeUris = [],
        alphaNow = 0.6,
    } = opts;


    await db.execute(sql`SELECT setseed(${Math.random()})`);

    // Build seed centroid from multiple URIs
    let s: number[] | null = null;
    if (seedUris.length) {
        const seeds = await getTracksByUris(seedUris);
        const seedVecs = seeds
            .map((t) => t.embedding)
            .filter((e): e is number[] => Array.isArray(e));
        s = centroidNormalized(seedVecs);
    }


    // Liked centroid
    const likedVecs = await getLikedEmbeddings();
    const c = centroidNormalized(likedVecs);

    // Blend q
    let q: number[] | null = null;
    if (s && c) {
        const dim = s.length;
        const blended = new Array(dim).fill(0);
        for (let i = 0; i < dim; i++) {
            blended[i] = alphaNow * s[i] + (1 - alphaNow) * c[i];
        }
        q = l2norm(blended);
    } else if (s) {
        q = s;
    } else if (c) {
        q = c;
    } else {
        // Fallback: random embedded seed
        const [rnd] = await db
            .select({ embedding: trackTable.embedding })
            .from(trackTable)
            .where(isNotNull(trackTable.embedding))
            .orderBy(() => sql`random()`)
            .limit(1);
        if (!rnd?.embedding) return [];
        q = l2norm(rnd.embedding);
    }

    const pool = await annCandidatesByQueryEmbedding(
        q,
        annPool ?? Math.max(limit * 8, 600),
        excludeUris
    );

    // MMR re-rank (allow artist streaks: no penalties, no caps)
    const poolN = pool
        .filter((p) => Array.isArray(p.embedding))
        .map((p) => ({ ...p, n: l2norm(p.embedding as number[]) }));

    const selected: typeof pool = [];

    while (selected.length < limit && poolN.length) {
        // 1) Compute scores
        const scores: number[] = [];
        for (let i = 0; i < poolN.length; i++) {
            const cand = poolN[i];

            // Relevance to q
            let rel = 0;
            for (let k = 0; k < q.length; k++) rel += cand.n[k] * q[k];

            // Diversity (MMR); set lambda = 1 to disable
            let div = 0;
            if (selected.length) {
                let maxSim = -Infinity;
                for (const s of selected) {
                    const sN = l2norm(s.embedding as number[]);
                    let sim = 0;
                    for (let k = 0; k < q.length; k++) sim += cand.n[k] * sN[k];
                    if (sim > maxSim) maxSim = sim;
                }
                div = maxSim;
            }

            const base = lambda * rel - (1 - lambda) * div;

            // Soft artist penalty (no hard cap)
            const aPenalty = softArtistPenalty(cand.artists);

            scores.push(base - aPenalty);
        }

        // 2) Choose an index with randomness
        let idxInPool: number;
        if (useSoftmax) {
            idxInPool = softmaxSample(scores, temperature);
        } else {
            // epsilon-greedy within top-K
            const idxs = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
            const explore =
                Math.random() < epsilon && poolN.length > 1 && selected.length > 0;
            if (explore) {
                const k = Math.min(topK, idxs.length);
                idxInPool = idxs[Math.floor(Math.random() * k)];
            } else {
                idxInPool = idxs[0];
            }
        }

        // 3) Select, update counts/streak, and re-seed q (D)
        const chosen = poolN.splice(idxInPool, 1)[0];
        selected.push(chosen);

        bumpArtistCounts(chosen.artists);
        updateStreak(chosen.artists);

        // Re-seed q toward chosen + tiny noise
        const x = l2norm(chosen.embedding as number[]);
        const mixed: number[] = new Array(q.length);
        for (let i = 0; i < q.length; i++) mixed[i] = beta * q[i] + (1 - beta) * x[i];
        q = l2norm(mixed);
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
