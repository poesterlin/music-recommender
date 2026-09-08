import { kmeans } from 'ml-kmeans';
import { trackTable } from './schema';
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

const allTracks = await db.select({
  uri: trackTable.uri,
  name: trackTable.name,
  artist: trackTable.artist,
  embedding: trackTable.embedding,
}).from(trackTable).limit(100000).orderBy(sql`random()`).where(isNotNull(trackTable.embedding));
const clusteringResult = clusterLibrary(allTracks, 60);

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
