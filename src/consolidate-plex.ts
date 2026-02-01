import { eq, like, and } from "drizzle-orm";
import { db } from "./db";
import { trackTable, likedSongsTable, skippedSongsTable } from "./schema";

const dryRun = process.argv.includes("--dry-run");

if (dryRun) {
  console.log("DRY RUN MODE ENABLED - No changes will be made to the database");
}

function normalizeString(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getMatchKey(name: string, artists: string[], album: string): string {
  const nName = normalizeString(name);
  const nAlbum = normalizeString(album);
  const nArtists = artists
    .flatMap(a => a.split(/,|&|feat\.?|featuring|vs\.?|with|w\/|x|\/|\+/i))
    .map(a => normalizeString(a))
    .filter(a => a.length > 0)
    .sort()
    .join("|");
  
  return `${nName}#${nArtists}#${nAlbum}`;
}

async function consolidate() {
  console.log("Fetching Plex tracks...");
  const plexTracks = await db.select().from(trackTable).where(like(trackTable.uri, "plex-%"));
  console.log(`Found ${plexTracks.length} Plex tracks.`);

  console.log("Fetching Library tracks...");
  const libraryTracks = await db.select().from(trackTable).where(like(trackTable.uri, "library://track/%"));
  console.log(`Found ${libraryTracks.length} Library tracks.`);

  // Create a map for faster lookup of library tracks
  const libraryMap = new Map();
  for (const track of libraryTracks) {
    const key = getMatchKey(track.name, track.artist, track.album);
    if (!libraryMap.has(key)) {
      libraryMap.set(key, track);
    }
  }

  let consolidatedCount = 0;

  for (const plexTrack of plexTracks) {
    const key = getMatchKey(plexTrack.name, plexTrack.artist, plexTrack.album);
    const libraryTrack = libraryMap.get(key);

    if (libraryTrack) {
      console.log(`Match found: "${plexTrack.name}" by ${plexTrack.artist.join(", ")}`);
      console.log(`  Plex URI: ${plexTrack.uri}`);
      console.log(`  Library URI: ${libraryTrack.uri}`);

      if (!dryRun) {
        await db.transaction(async (tx) => {
          // Consolidate information to library track if it's missing
          const updates: Partial<typeof trackTable.$inferInsert> = {};
          if (!libraryTrack.embedding && plexTrack.embedding) {
            updates.embedding = plexTrack.embedding;
          }
          if (libraryTrack.clusterId === -1 && plexTrack.clusterId !== -1) {
            updates.clusterId = plexTrack.clusterId;
          }
          if (!libraryTrack.skip && plexTrack.skip) {
            updates.skip = plexTrack.skip;
          }

          if (Object.keys(updates).length > 0) {
            console.log(`  Updating library track with consolidated info: ${JSON.stringify(updates)}`);
            await tx.update(trackTable).set(updates).where(eq(trackTable.uri, libraryTrack.uri));
          }

          // Delete Plex track
          console.log(`  Deleting Plex track: ${plexTrack.uri}`);
          await tx.delete(trackTable).where(eq(trackTable.uri, plexTrack.uri));
        });
      } else {
        console.log(`  [Dry Run] Would consolidate and delete ${plexTrack.uri}`);
      }
      consolidatedCount++;
    }
  }

  console.log(`Finished. Consolidated ${consolidatedCount} tracks.`);
}

consolidate().catch(console.error);
