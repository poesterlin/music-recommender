import { sql } from "drizzle-orm";
import { db } from "../web/src/lib/server/db";
import { trackTable } from "../web/src/lib/server/schema";

const BATCH_SIZE = 500;
const GENERATE_SQL = process.argv.includes("--generate-sql");

interface Track {
  uri: string;
  name: string;
  artists: { name: string }[];
  album: { name: string };
}

function normalize(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getMatchKey(name: string, artists: string[], album: string): string {
  const nName = normalize(name);
  const nAlbum = normalize(album);
  const nArtists = artists
    .map(a => normalize(a))
    .sort()
    .join("|");
  return `${nName}#${nArtists}#${nAlbum}`;
}

function escapeSql(s: string): string {
  return s.replace(/'/g, "''").replace(/\\/g, "\\\\");
}

function vecStr(v: number[]): string {
  return JSON.stringify(v);
}

async function main() {
  const env = process.env;
  const authHeaders = new Headers();
  authHeaders.append("Content-Type", "application/json");
  authHeaders.append("Authorization", "Bearer " + env.TOKEN);

  console.error("Fetching tracks from Music Assistant...");
  let offset = 0;
  const maByName = new Map<string, Track>();

  while (true) {
    const raw = JSON.stringify({
      config_entry_id: env.CONFIG_ID,
      media_type: "track",
      limit: BATCH_SIZE,
      offset,
      order_by: "sort_name",
    });

    const res = await fetch(
      env.HOST + "/api/services/music_assistant/get_library?return_response",
      { method: "POST", headers: authHeaders, body: raw, redirect: "follow" }
    );

    if (res.status !== 200) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    const data = await res.json();
    const items = data.service_response?.items;
    if (!items || items.length === 0) break;

    for (const t of items) {
      const key = getMatchKey(
        t.name,
        t.artists.map((a: any) => a.name),
        t.album.name
      );
      maByName.set(key, t);
    }
    console.error(`  ${maByName.size}`);
    if (items.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }
  console.error(`MA library: ${maByName.size}`);

  console.error("Fetching DB tracks...");
  const dbTracks = await db
    .select()
    .from(trackTable)
    .where(sql`${trackTable.uri} LIKE 'library://track/%'`);

  const dbByUri = new Map(dbTracks.map(t => [t.uri, t]));
  console.error(`DB tracks: ${dbTracks.length}`);

  // old_uri → new_uri (only when they differ)
  const mapping = new Map<string, string>();

  for (const dbTrack of dbTracks) {
    const key = getMatchKey(dbTrack.name, dbTrack.artist, dbTrack.album);
    const maMatch = maByName.get(key);
    if (!maMatch || maMatch.uri === dbTrack.uri) continue;
    mapping.set(dbTrack.uri, maMatch.uri);
  }

  // Split: new_uri already in DB → conflict (merge+delete old)
  //        new_uri not in DB      → rename (update uri in place)
  // For renames, deduplicate: pick one old_uri per new_uri (prefer one with embedding)
  const newUriToOlds = new Map<string, string[]>(); // new_uri → list of old_uris
  for (const [oldUri, newUri] of mapping) {
    if (!newUriToOlds.has(newUri)) newUriToOlds.set(newUri, []);
    newUriToOlds.get(newUri)!.push(oldUri);
  }

  type MappingRow = { oldUri: string; newUri: string; embedding: string | null; action: "merge" | "rename" | "delete" };

  const rows: MappingRow[] = [];
  let mergeCount = 0;
  let renameCount = 0;
  let deleteCount = 0;

  for (const [newUri, oldUris] of newUriToOlds) {
    if (dbByUri.has(newUri)) {
      // CONFLICT: new URI already exists in DB
      // For each old URI: merge its embedding into new row, then delete old
      for (const oldUri of oldUris) {
        const oldTrack = dbByUri.get(oldUri);
        const emb = oldTrack?.embedding ? vecStr(oldTrack.embedding) : null;
        rows.push({ oldUri, newUri, embedding: emb, action: "merge" });
        mergeCount++;
      }
    } else {
      // RENAME: new URI is free
      // Pick ONE old row to rename (prefer one with embedding), delete the rest
      oldUris.sort((a, b) => {
        const ea = dbByUri.get(a)?.embedding ? 1 : 0;
        const eb = dbByUri.get(b)?.embedding ? 1 : 0;
        return eb - ea; // has embedding first
      });

      const [keeper, ...deletables] = oldUris;
      rows.push({ oldUri: keeper, newUri, embedding: null, action: "rename" });
      renameCount++;

      for (const oldUri of deletables) {
        rows.push({ oldUri, newUri, embedding: null, action: "delete" });
        deleteCount++;
      }
    }
  }

  console.error(`\nMerge (conflict): ${mergeCount}, Rename: ${renameCount}, Delete (deduped): ${deleteCount}`);
  console.error(`Total uri_map rows: ${rows.length}`);

  if (!GENERATE_SQL) {
    console.error(`Run with --generate-sql to output SQL.`);
    return;
  }

  console.log("-- ===================================================");
  console.log("-- URI FIXUP SCRIPT");
  console.log(`-- Merges: ${mergeCount}, Renames: ${renameCount}, Deletes: ${deleteCount}`);
  console.log("-- ===================================================");
  console.log("");
  console.log("BEGIN;");
  console.log("");
  console.log("CREATE TEMP TABLE uri_map (old_uri text, new_uri text, embedding text, action text);");
  console.log("");

  // Insert all rows
  for (const r of rows) {
    console.log(`INSERT INTO uri_map VALUES ('${escapeSql(r.oldUri)}', '${escapeSql(r.newUri)}', ${r.embedding ? `'${r.embedding}'` : 'NULL'}, '${r.action}');`);
  }
  console.log("");

  // Phase 1: Merge embeddings into existing new-URI rows
  console.log("-- Phase 1: Copy embeddings from old rows into existing new-URI rows");
  console.log("UPDATE track");
  console.log("SET embedding = uri_map.embedding::vector");
  console.log("FROM uri_map");
  console.log("WHERE track.uri = uri_map.new_uri AND uri_map.action = 'merge' AND uri_map.embedding IS NOT NULL;");
  console.log("");

  // Phase 2: Delete old rows marked for merge (their new URI already existed)
  console.log("-- Phase 2: Delete old rows where new URI already existed (merged + dedup-deletes)");
  console.log("DELETE FROM track");
  console.log("USING uri_map");
  console.log("WHERE track.uri = uri_map.old_uri AND uri_map.action IN ('merge', 'delete');");
  console.log("");

  // Phase 3: Rename old rows where new URI is free
  console.log("-- Phase 3: Rename old URIs in place (new URI was free)");
  console.log("UPDATE track");
  console.log("SET uri = uri_map.new_uri");
  console.log("FROM uri_map");
  console.log("WHERE track.uri = uri_map.old_uri AND uri_map.action = 'rename';");
  console.log("");

  // Phase 4: Handle liked_songs (dedupe first, then update)
  console.log("-- Phase 4a: Delete liked_songs rows that would become duplicates");
  console.log("DELETE FROM liked_songs");
  console.log("USING uri_map");
  console.log("WHERE liked_songs.uri = uri_map.old_uri");
  console.log("  AND EXISTS (SELECT 1 FROM liked_songs ls2 WHERE ls2.uri = uri_map.new_uri);");
  console.log("");
  console.log("-- Phase 4b: Update remaining liked_songs URIs");
  console.log("UPDATE liked_songs");
  console.log("SET uri = uri_map.new_uri");
  console.log("FROM uri_map");
  console.log("WHERE liked_songs.uri = uri_map.old_uri;");
  console.log("");

  // Phase 5: Handle skipped_songs (same pattern)
  console.log("-- Phase 5a: Delete skipped_songs rows that would become duplicates");
  console.log("DELETE FROM skipped_songs");
  console.log("USING uri_map");
  console.log("WHERE skipped_songs.uri = uri_map.old_uri");
  console.log("  AND EXISTS (SELECT 1 FROM skipped_songs ss2 WHERE ss2.uri = uri_map.new_uri);");
  console.log("");
  console.log("-- Phase 5b: Update remaining skipped_songs URIs");
  console.log("UPDATE skipped_songs");
  console.log("SET uri = uri_map.new_uri");
  console.log("FROM uri_map");
  console.log("WHERE skipped_songs.uri = uri_map.old_uri;");
  console.log("");

  console.log("DROP TABLE uri_map;");
  console.log("");
  console.log("COMMIT;");
  console.log("");

  // Hardcoded seeds
  console.log("-- ===================================================");
  console.log("-- HARDCODED SEEDS IN src/server.ts TO UPDATE MANUALLY");
  console.log("-- ===================================================");
  for (const sid of [532, 7333, 784]) {
    const oldUri = `library://track/${sid}`;
    const newUri = mapping.get(oldUri);
    if (newUri) {
      console.log(`-- library://track/${sid}  →  ${newUri}`);
    } else {
      const t = dbByUri.get(oldUri);
      console.log(`-- library://track/${sid}  →  ${t ? `NOT IN MA (was: ${t.name})` : 'NOT IN DB'}`);
    }
  }
}

main().catch(console.error);
