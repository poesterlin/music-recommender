import { kmeans } from 'ml-kmeans';
import { trackTable } from './schema';
import { db } from './db';
import { eq, isNotNull, sql } from 'drizzle-orm';

/**
 * Clusters your library and finds the "Centroid" tracks.
 * @param tracks All tracks with embeddings from your DB
 * @param k Number of clusters (e.g., 6 for different times of day)
 */
export function clusterLibrary(tracks: any[], k = 6) {
  const embeddings = tracks.map(t => t.embedding);

  // Perform K-Means
  const ans = kmeans(embeddings, k, {
    initialization: 'kmeans++',
  });

  // Find the track closest to each cluster center (the "Seed Song")
  const clusterSeeds = ans.centroids.map((centroid) => {
    let bestTrack = null;
    let minDistance = Infinity;

    for (const track of tracks) {
      const dist = cosineDistance(track.embedding, centroid);
      if (dist < minDistance) {
        minDistance = dist;
        bestTrack = track;
      }
    }
    return bestTrack;
  });

  return {
    clusters: ans.clusters, // Array of cluster indices for every track
    seeds: clusterSeeds     // The 6 tracks that best represent the vibes
  };
}

function cosineDistance(vecA: number[], vecB: number[]): number {
  const dotProduct = vecA.reduce((sum, a, idx) => sum + a * vecB[idx], 0);
  const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
  const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
  return 1 - (dotProduct / (magnitudeA * magnitudeB));
}

export async function batchUpdateClusters(
  updates: { uri: string; clusterId: number }[],
  chunkSize = 50
) {
  console.log(`Starting stable update for ${updates.length} tracks...`);

  for (let i = 0; i < updates.length; i += chunkSize) {
    const chunk = updates.slice(i, i + chunkSize);

    try {
      // Wrap each chunk in a transaction
      // await db.transaction(async (tx) => {
      for (const update of chunk) {
        await db
          .update(trackTable)
          .set({ clusterId: update.clusterId })
          .where(eq(trackTable.uri, update.uri));
      }
      // });

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

const updates = allTracks.map((track, index) => ({
  uri: track.uri,
  clusterId: clusteringResult.clusters[index] // index from kmeans matches index of input array
}));

// 3. Run the chunked update
await batchUpdateClusters(updates, 150);