import { kmeans } from 'ml-kmeans';
import { trackTable, clusterCentroidTable } from './schema';
import { db } from './db';
import { isNotNull, sql } from 'drizzle-orm';

type TrackWithEmbedding = {
  uri: string;
  name: string;
  artist: string[];
  embedding: number[];
};

type NormalizedTrack = TrackWithEmbedding & {
  normalizedEmbedding: Float32Array;
};

type ClusterResult = {
  clusters: number[];
  seeds: TrackWithEmbedding[];
  clusteredTracks: TrackWithEmbedding[];
};

/**
 * Clusters your library and finds the "Centroid" tracks.
 * @param tracks All tracks with embeddings from your DB
 * @param k Number of clusters (e.g., 6 for different times of day)
 */
export function clusterLibrary(tracks: any[], k = 6) {
  const validTracks = tracks.filter(
    (track): track is TrackWithEmbedding =>
      Array.isArray(track?.embedding) && track.embedding.length > 0
  );

  if (validTracks.length === 0) {
    return {
      clusters: [] as number[],
      seeds: [] as TrackWithEmbedding[],
      clusteredTracks: [] as TrackWithEmbedding[],
    } satisfies ClusterResult;
  }

  const dim = validTracks[0].embedding.length;
  const normalizedTracks: NormalizedTrack[] = [];
  for (const track of validTracks) {
    if (track.embedding.length !== dim) continue;
    normalizedTracks.push({
      ...track,
      normalizedEmbedding: normalizeToFloat32(track.embedding),
    });
  }

  if (normalizedTracks.length === 0) {
    return {
      clusters: [] as number[],
      seeds: [] as TrackWithEmbedding[],
      clusteredTracks: [] as TrackWithEmbedding[],
    } satisfies ClusterResult;
  }

  const effectiveK = Math.max(1, Math.min(k, normalizedTracks.length));
  const embeddings = normalizedTracks.map((track) => track.normalizedEmbedding);

  // Perform K-Means
  const ans = kmeans(embeddings as unknown as number[][], effectiveK, {
    initialization: 'kmeans++',
    maxIterations: 100,
  });

  const normalizedCentroids = ans.centroids.map((centroidLike: any) =>
    normalizeToFloat32(getCentroidVector(centroidLike))
  );

  const bestTrackPerCluster: (TrackWithEmbedding | null)[] = new Array(effectiveK).fill(null);
  const minDistancePerCluster = new Array(effectiveK).fill(Infinity);

  for (let index = 0; index < normalizedTracks.length; index++) {
    const clusterId = ans.clusters[index];
    if (clusterId == null || clusterId < 0 || clusterId >= normalizedCentroids.length) {
      continue;
    }

    const track = normalizedTracks[index];
    const dist = cosineDistance(track.normalizedEmbedding, normalizedCentroids[clusterId]);
    if (dist < minDistancePerCluster[clusterId]) {
      minDistancePerCluster[clusterId] = dist;
      bestTrackPerCluster[clusterId] = {
        uri: track.uri,
        name: track.name,
        artist: track.artist,
        embedding: track.embedding,
      };
    }
  }

  // Fallback if a cluster is unexpectedly empty
  const clusterSeeds = normalizedCentroids.map((centroid, clusterId) => {
    const clusterSeed = bestTrackPerCluster[clusterId];
    if (clusterSeed) return clusterSeed;

    let bestTrack: TrackWithEmbedding | null = null;
    let minDistance = Infinity;

    for (const track of normalizedTracks) {
      const dist = cosineDistance(track.normalizedEmbedding, centroid);
      if (dist < minDistance) {
        minDistance = dist;
        bestTrack = {
          uri: track.uri,
          name: track.name,
          artist: track.artist,
          embedding: track.embedding,
        };
      }
    }

    return bestTrack!;
  });

  return {
    clusters: ans.clusters, // Array of cluster indices for every track
    seeds: clusterSeeds,    // The k tracks that best represent the vibes
    clusteredTracks: normalizedTracks.map((track) => ({
      uri: track.uri,
      name: track.name,
      artist: track.artist,
      embedding: track.embedding,
    })),
  };
}

function cosineDistance(vecA: Float32Array, vecB: Float32Array): number {
  let dotProduct = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
  }
  return 1 - dotProduct;
}

function normalizeToFloat32(vec: number[]): Float32Array {
  let magnitudeSquared = 0;
  for (let i = 0; i < vec.length; i++) {
    magnitudeSquared += vec[i] * vec[i];
  }

  const out = new Float32Array(vec.length);

  if (magnitudeSquared === 0) {
    for (let i = 0; i < vec.length; i++) {
      out[i] = vec[i];
    }
    return out;
  }

  const magnitude = Math.sqrt(magnitudeSquared);
  for (let i = 0; i < vec.length; i++) {
    out[i] = vec[i] / magnitude;
  }
  return out;
}

function getCentroidVector(centroidLike: any): number[] {
  if (Array.isArray(centroidLike)) {
    return centroidLike;
  }

  if (Array.isArray(centroidLike?.centroid)) {
    return centroidLike.centroid;
  }

  throw new Error('KMeans returned an unexpected centroid format.');
}

export async function batchUpdateClusters(
  updates: { uri: string; clusterId: number }[],
  chunkSize = 50
) {
  console.log(`Starting stable update for ${updates.length} tracks...`);

  for (let i = 0; i < updates.length; i += chunkSize) {
    const chunk = updates.slice(i, i + chunkSize);

    try {
      const values = sql.join(
        chunk.map((update) => sql`(${update.uri}, ${update.clusterId})`),
        sql`, `
      );

      await db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE track AS t
          SET cluster_id = v.cluster_id
          FROM (VALUES ${values}) AS v(uri, cluster_id)
          WHERE t.uri = v.uri
        `);
      });

      console.log(
        `Success: Chunk ${i / chunkSize + 1} / ${Math.ceil(
          updates.length / chunkSize
        )}`
      );
    } catch (error) {
      console.error(`Error in chunk starting at ${i}:`, error);
      // You can decide whether to 'continue' to the next chunk or 'throw'
    }
  }

  console.log("Update process complete.");
}

// ---------- Stable incremental clustering ----------
// Instead of re-running k-means (which renumbers/shifts every cluster),
// centroids are frozen in cluster_centroid. New tracks are assigned to
// the nearest centroid; existing cluster_ids are never touched.

export type Centroid = { clusterId: number; embedding: number[]; trackCount: number };

function l2normalize(vec: number[]): number[] {
  const n = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map((x) => x / n);
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // inputs are L2-normalized
}

export async function loadCentroids(): Promise<Centroid[]> {
  const rows = await db.select().from(clusterCentroidTable);
  return rows
    .filter((r) => Array.isArray(r.embedding) && r.embedding.length > 0)
    .map((r) => ({
      clusterId: r.clusterId,
      embedding: l2normalize(r.embedding as number[]),
      trackCount: r.trackCount ?? 0,
    }));
}

/**
 * Bootstrap centroids from CURRENT cluster assignments without moving
 * anything: centroid[c] = normalized mean of member embeddings.
 * Skips cluster -1 (unplaced) and empty clusters.
 */
export async function backfillCentroidsFromAssignments(): Promise<Centroid[]> {
  const rows = await db
    .select({ clusterId: trackTable.clusterId, embedding: trackTable.embedding })
    .from(trackTable)
    .where(isNotNull(trackTable.embedding));

  const sums = new Map<number, { sum: number[]; count: number }>();
  for (const row of rows) {
    const cid = row.clusterId;
    const emb = row.embedding as number[] | null;
    if (cid == null || cid < 0 || !Array.isArray(emb) || !emb.length) continue;
    let acc = sums.get(cid);
    if (!acc) {
      acc = { sum: new Array(emb.length).fill(0), count: 0 };
      sums.set(cid, acc);
    }
    if (acc.sum.length !== emb.length) continue;
    for (let i = 0; i < emb.length; i++) acc.sum[i] += emb[i];
    acc.count++;
  }

  const centroids: Centroid[] = [];
  for (const [cid, acc] of sums) {
    const mean = acc.sum.map((s) => s / acc.count);
    centroids.push({ clusterId: cid, embedding: l2normalize(mean), trackCount: acc.count });
  }

  for (const c of centroids) {
    await db
      .insert(clusterCentroidTable)
      .values({ clusterId: c.clusterId, embedding: c.embedding, trackCount: c.trackCount })
      .onConflictDoUpdate({
        target: clusterCentroidTable.clusterId,
        set: { embedding: c.embedding, trackCount: c.trackCount },
      });
  }
  console.log(`Backfilled ${centroids.length} centroids from current assignments.`);
  return centroids;
}

/**
 * Assign every embedded but unclustered track (cluster_id -1/NULL) to its
 * nearest frozen centroid. Existing assignments are never modified.
 * Returns the number of tracks assigned.
 */
export async function assignNewTracksToClusters(centroids?: Centroid[]): Promise<number> {
  const cents = centroids ?? (await loadCentroids());
  if (!cents.length) throw new Error("No centroids stored - run backfill or full clustering first.");

  const pending = await db
    .select({ uri: trackTable.uri, embedding: trackTable.embedding })
    .from(trackTable)
    .where(sql`${trackTable.embedding} IS NOT NULL AND (${trackTable.clusterId} = -1 OR ${trackTable.clusterId} IS NULL)`);

  if (!pending.length) {
    console.log("No unclustered embedded tracks - nothing to do.");
    return 0;
  }

  const updates: { uri: string; clusterId: number }[] = [];
  for (const t of pending) {
    const emb = t.embedding as number[] | null;
    if (!Array.isArray(emb) || !emb.length) continue;
    const norm = l2normalize(emb);
    if (norm.length !== cents[0].embedding.length) continue;
    let best = cents[0].clusterId;
    let bestSim = -Infinity;
    for (const c of cents) {
      const s = cosineSim(norm, c.embedding);
      if (s > bestSim) {
        bestSim = s;
        best = c.clusterId;
      }
    }
    updates.push({ uri: t.uri, clusterId: best });
  }

  await batchUpdateClusters(updates, 150);
  console.log(`Assigned ${updates.length} new tracks to frozen clusters.`);
  return updates.length;
}

async function runFullClustering(k = 60) {
  const allTracks = await db.select({
    uri: trackTable.uri,
    name: trackTable.name,
    artist: trackTable.artist,
    embedding: trackTable.embedding,
  }).from(trackTable).limit(100000).orderBy(sql`random()`).where(isNotNull(trackTable.embedding));
  const clusteringResult = clusterLibrary(allTracks, k);

  console.log("Cluster Seeds:");
  clusteringResult.seeds.forEach((track, idx) => {
    console.log(`Cluster ${idx + 1}: ${track.name} by ${track.artist.join(", ")}`);
  });

  const updates = clusteringResult.clusteredTracks.map((track, index) => ({
    uri: track.uri,
    clusterId: clusteringResult.clusters[index] // index from kmeans matches index of clusteredTracks
  }));

  // 3. Run the chunked update
  await batchUpdateClusters(updates, 150);
  // Freeze the new layout so future runs can be incremental
  await backfillCentroidsFromAssignments();
}

if (import.meta.main) {
  const mode = process.argv[2] ?? "incremental";
  if (mode === "full") {
    const k = Number(process.argv[3] ?? 60);
    console.log(`Running FULL k-means clustering (k=${k}) - all cluster_ids will be rewritten.`);
    await runFullClustering(k);
  } else if (mode === "backfill") {
    console.log("Backfilling centroids from current assignments (moves nothing).");
    await backfillCentroidsFromAssignments();
  } else if (mode === "incremental") {
    console.log("Assigning new tracks to frozen clusters (existing assignments untouched).");
    await assignNewTracksToClusters();
  } else {
    console.error(`Unknown mode: ${mode}. Use: full [k] | backfill | incremental`);
    process.exit(1);
  }
}
