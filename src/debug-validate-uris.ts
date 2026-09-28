import { sql } from "drizzle-orm";
import { db } from "../web/src/lib/server/db";
import { scanLibrary } from "../web/src/lib/server/ma-library";
import { trackTable } from "../web/src/lib/server/schema";

const PAGE_SIZE = 1000;
const SAMPLE_SIZE = 10;

type MaEntry = { name: string; album: string; artists: string[] };

function normalize(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Identity of a track by content rather than by URI. Music Assistant's library
 * IDs are not stable across a re-import, so a URI that has gone stale almost
 * always still matches a row by name, album and artist set.
 */
function matchKey(name: string, album: string, artists: string[]): string {
  const nArtists = artists
    .map((a) => normalize(a))
    .sort()
    .join("|");
  return `${normalize(name)}#${normalize(album)}#${nArtists}`;
}

async function fetchLibrary(): Promise<Map<string, MaEntry>> {
  console.log("Fetching the current track list from Music Assistant...");

  const tracks = new Map<string, MaEntry>();
  await scanLibrary({ limit: PAGE_SIZE }, async (items) => {
    for (const track of items) {
      if (!track?.uri) continue;
      tracks.set(track.uri, {
        name: track.name ?? "",
        album: track.album?.name ?? "",
        artists: (track.artists ?? []).map((a) => a.name ?? "").filter(Boolean),
      });
    }
  });

  console.log(`Music Assistant library has ${tracks.size} tracks`);
  return tracks;
}

async function main() {
  const maTracks = await fetchLibrary();
  console.log("");

  const dbRows = await db
    .select({
      uri: trackTable.uri,
      name: trackTable.name,
      artists: trackTable.artist,
      album: trackTable.album,
    })
    .from(trackTable);

  const dbByUri = new Map(dbRows.map((t) => [t.uri, t]));
  const libraryUris = new Set(
    dbRows.filter((t) => t.uri.startsWith("library://track/")).map((t) => t.uri),
  );

  console.log(`Sole DB has ${dbRows.length} tracks`);
  console.log(`  Of which ${libraryUris.size} are library://track/ URIs`);

  const staleUris = [...libraryUris].filter((uri) => !maTracks.has(uri));
  const missingUris = [...maTracks.keys()].filter((uri) => !dbByUri.has(uri));

  console.log("");
  console.log(`=== Stale URIs (in DB but NOT in MA): ${staleUris.length} ===`);

  if (staleUris.length > 0) {
    // Index the MA side by content once, so each stale row is an O(1) lookup
    // rather than a scan of the whole library.
    const byContent = new Map<string, string[]>();
    for (const [uri, entry] of maTracks) {
      const key = matchKey(entry.name, entry.album, entry.artists);
      const bucket = byContent.get(key);
      if (bucket) bucket.push(uri);
      else byContent.set(key, [uri]);
    }

    for (const uri of staleUris.slice(0, SAMPLE_SIZE)) {
      const t = dbByUri.get(uri);
      if (!t) continue;
      const key = matchKey(t.name, t.album, t.artists);
      const candidates = byContent.get(key) ?? [];
      if (candidates.length > 0) {
        for (const candidate of candidates) {
          console.log(`  OLD: ${uri} — ${t.name}`);
          console.log(`  NEW: ${candidate} — same track, different library id`);
        }
      } else {
        console.log(`  ${uri} — ${t.name}: not in MA at all (possibly deleted)`);
      }
    }

    if (staleUris.length > SAMPLE_SIZE) {
      console.log(`  ... and ${staleUris.length - SAMPLE_SIZE} more stale URIs`);
    }
  }

  console.log("");
  console.log(`=== Missing URIs (in MA but NOT in DB): ${missingUris.length} ===`);
  if (missingUris.length > 0) {
    console.log("  Re-run the library index to import these");
    for (const uri of missingUris.slice(0, 20)) {
      const t = maTracks.get(uri)!;
      console.log(`  ${uri} — ${t.name} by ${t.artists.join(", ")}`);
    }
    if (missingUris.length > 20) {
      console.log(`  ... and ${missingUris.length - 20} more`);
    }
  }

  console.log("");
  console.log("=== Verdict ===");
  if (staleUris.length === 0 && missingUris.length === 0) {
    console.log("Every indexed URI still resolves in Music Assistant.");
  } else if (staleUris.length > 0) {
    console.log(
      `${staleUris.length} rows point at library ids Music Assistant no longer has. ` +
        "The recommendation endpoint repairs these in place by matching on name, album and artist; " +
        "Manage -> Duplicates -> Prune all is what actually removes them."
    );
  } else {
    console.log("The index is behind the library but nothing is stale; a re-index will catch up.");
  }
}

main().catch(console.error);
