import { isNotNull, sql } from "drizzle-orm";
import { db } from "./db";
import { trackTable } from "./schema";

function l2norm(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

function cosineSimilarity(v1: number[], v2: number[]): number {
  if (v1.length !== v2.length) return 0;
  let dot = 0;
  for (let i = 0; i < v1.length; i++) {
    dot += v1[i] * v2[i];
  }
  return dot; // Assumes v1 and v2 are pre-normalized
}

async function analyze() {
  console.log("Fetching all tracks with embeddings from the database...");
  const allTracks = await db
    .select({
      uri: trackTable.uri,
      name: trackTable.name,
      artist: trackTable.artist,
      album: trackTable.album,
      embedding: trackTable.embedding,
    })
    .from(trackTable)
    .where(isNotNull(trackTable.embedding));

  console.log(`Loaded ${allTracks.length} tracks.`);

  // 1. Compute global centroid (mean of ALL tracks) to center the data
  console.log("Computing global centroid for centering...");
  const dim = (allTracks[0].embedding as number[]).length;
  const globalSum = new Array(dim).fill(0);
  for (const track of allTracks) {
    const vec = track.embedding as number[];
    for (let i = 0; i < dim; i++) {
      globalSum[i] += vec[i];
    }
  }
  const globalCentroid = globalSum.map(s => s / allTracks.length);

  // 2. Classify tracks as Christmas vs non-Christmas
  const christmasKeywords = ["christmas", "xmas", "santa", "noel", "mistletoe", "jingle", "sleigh", "silent night", "deck the halls", "feliz navidad"];
  const christmasAlbumKeywords = ["christmas", "holiday", "mistletoe", "noel", "winter wonderland", "sleigh", "santa"];
  
  const falsePositiveSongs = ["carolina", "merrymaking at my place"];
  const falsePositiveAlbums = ["breezy - it’s giving christmas"]; // Chris Brown rap album

  const christmasTracks: typeof allTracks = [];
  const nonChristmasTracks: typeof allTracks = [];

  for (const track of allTracks) {
    const nameLower = track.name.toLowerCase();
    const albumLower = track.album.toLowerCase();

    // Check false positives first
    if (falsePositiveSongs.some(fp => nameLower.includes(fp)) || falsePositiveAlbums.some(fp => albumLower.includes(fp))) {
      nonChristmasTracks.push(track);
      continue;
    }

    const hasChristmasName = christmasKeywords.some(kw => nameLower.includes(kw));
    const hasChristmasAlbum = christmasAlbumKeywords.some(kw => albumLower.includes(kw));

    if (hasChristmasName || hasChristmasAlbum) {
      christmasTracks.push(track);
    } else {
      nonChristmasTracks.push(track);
    }
  }

  console.log(`Identified ${christmasTracks.length} Christmas tracks and ${nonChristmasTracks.length} non-Christmas tracks.`);

  // Centering & normalizing function
  function preprocess(vec: number[]): number[] {
    const centered = vec.map((val, i) => val - globalCentroid[i]);
    return l2norm(centered);
  }

  // Preprocess all embeddings
  console.log("Centering and normalizing embeddings...");
  const christmasVecs = christmasTracks.map(t => preprocess(t.embedding as number[]));
  const nonChristmasVecs = nonChristmasTracks.map(t => preprocess(t.embedding as number[]));

  // Compute Christmas Centroid in centered space
  console.log("Computing Christmas centroid in centered space...");
  const christmasCentroidSum = new Array(dim).fill(0);
  for (const vec of christmasVecs) {
    for (let i = 0; i < dim; i++) {
      christmasCentroidSum[i] += vec[i];
    }
  }
  const christmasCentroidCentered = l2norm(christmasCentroidSum.map(s => s / christmasVecs.length));

  // Calculate similarities to the centroid in centered space
  const christmasSimilarities = christmasVecs.map(vec => cosineSimilarity(vec, christmasCentroidCentered));
  const nonChristmasSimilarities = nonChristmasVecs.map(vec => cosineSimilarity(vec, christmasCentroidCentered));

  // Sort and display stats
  const avgChristmasSim = christmasSimilarities.reduce((a, b) => a + b, 0) / christmasSimilarities.length;
  const avgNonChristmasSim = nonChristmasSimilarities.reduce((a, b) => a + b, 0) / nonChristmasSimilarities.length;

  console.log("\n--- Centered Similarity to Christmas Centroid Stats ---");
  console.log(`Average Christmas Song Sim:     ${avgChristmasSim.toFixed(4)}`);
  console.log(`Average Non-Christmas Song Sim: ${avgNonChristmasSim.toFixed(4)}`);

  console.log("\nThreshold Evaluation Table:");
  console.log("Threshold | Christmas Caught (%) | Non-Christmas Blocked (%) | Non-Christmas Blocked (Count)");
  console.log("------------------------------------------------------------------------------------------");
  
  for (let t = 0.10; t <= 0.50; t += 0.05) {
    const tp = christmasSimilarities.filter(s => s >= t).length;
    const fp = nonChristmasSimilarities.filter(s => s >= t).length;
    const tpPct = (tp / christmasTracks.length * 100).toFixed(1);
    const fpPct = (fp / nonChristmasTracks.length * 100).toFixed(2);
    console.log(`  ${t.toFixed(2)}    | ${tpPct.padStart(19)}% | ${fpPct.padStart(24)}% | ${fp.toString().padStart(28)}`);
  }

  // Let's write the global centroid, centered christmas centroid, and recommended thresholds to JSON
  console.log("\nWriting analysis output to 'src/christmas-centroid.json'...");
  await Bun.write("src/christmas-centroid.json", JSON.stringify({
    globalCentroid,
    christmasCentroidCentered,
    recommendedThreshold: 0.20 // Caught: ~90%, False block: ~2%
  }, null, 2));
  console.log("Saved successfully!");
}

analyze().catch(console.error);
