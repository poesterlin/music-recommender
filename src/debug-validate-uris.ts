import { sql } from "drizzle-orm";
import { db } from "../web/src/lib/server/db";
import { trackTable } from "../web/src/lib/server/schema";

const BATCH_SIZE = 500;
const SAMPLE_SIZE = 10;

interface Artist {
  name: string;
}

interface Album {
  name: string;
  artists: Artist[];
}

interface Track {
  uri: string;
  name: string;
  version: string;
  artists: Artist[];
  album: Album;
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

async function fetchAllMAURIs(): Promise<Map<string, Track>> {
  const env = process.env;
  const authHeaders = new Headers();
  authHeaders.append("Content-Type", "application/json");
  authHeaders.append("Authorization", "Bearer " + env.TOKEN);

  const uriMap = new Map<string, Track>();
  let offset = 0;

  console.log("Fetching current track list from Music Assistant...");

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
      uriMap.set(t.uri, t);
    }

    console.log(`  Fetched ${items.length} tracks (total: ${uriMap.size})`);

    if (items.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }

  console.log(`MA library has ${uriMap.size} tracks`);
  return uriMap;
}

async function main() {
  const maUris = await fetchAllMAURIs();
  console.log("");

  const seedUris = [
    "library://track/532",
    "library://track/7333",
    "library://track/784",
  ];

  console.log("=== Hardcoded Seed URIs ===");
  for (const uri of seedUris) {
    const found = maUris.has(uri);
    console.log(`  ${uri}: ${found ? "VALID" : "STALE (not found in MA)"}`);
  }
  console.log("");

  const [totalRow] = await db
    .select({ count: sql<string>`count(*)` })
    .from(trackTable);
  const dbTotal = Number(totalRow?.count ?? 0);
  console.log(`Recommender DB has ${dbTotal} tracks`);

  const dbURIs = await db
    .select({ uri: trackTable.uri })
    .from(trackTable)
    .where(sql`${trackTable.uri} LIKE 'library://track/%'`);

  const dbUriSet = new Set(dbURIs.map((r) => r.uri));
  console.log(`  Of which ${dbUriSet.size} are library://track/ URIs`);

  const staleUris = [...dbUriSet].filter((uri) => !maUris.has(uri));
  const missingUris = [...maUris.keys()].filter((uri) => !dbUriSet.has(uri));

  console.log("");
  console.log(`=== Stale URIs (in DB but NOT in MA): ${staleUris.length} ===`);

  if (staleUris.length > 0) {
    const sampleStale = staleUris.slice(0, SAMPLE_SIZE);
    const allDBTracks = await db
      .select({
        uri: trackTable.uri,
        name: trackTable.name,
        artists: trackTable.artist,
        album: trackTable.album,
      })
      .from(trackTable)
      .where(sql`${trackTable.uri} LIKE 'library://track/%'`);

    const dbTrackMap = new Map(allDBTracks.map((t) => [t.uri, t]));

    for (const uri of sampleStale) {
      const t = dbTrackMap.get(uri);
      if (!t) continue;
      console.log(`  ${t.uri} — ${t.name} by ${t.artists.join(", ")} (${t.album})`);
    }

    if (staleUris.length > SAMPLE_SIZE) {
      console.log(`  ... and ${staleUris.length - SAMPLE_SIZE} more stale URIs`);
    }

    console.log("");
    console.log("=== Fuzzy Lookup: can these stale tracks be found under new URIs? ===");
    for (const uri of sampleStale) {
      const t = dbTrackMap.get(uri);
      if (!t) continue;
      const nName = normalize(t.name);
      const nAlbum = normalize(t.album);
      const candidates = [...maUris.values()].filter((ma) => {
        if (normalize(ma.name) !== nName) return false;
        if (normalize(ma.album.name) !== nAlbum) return false;
        const maArtistNorm = ma.artists.map((a) => normalize(a.name)).sort().join("|");
        const dbArtistNorm = t.artists.map((a) => normalize(a)).sort().join("|");
        return maArtistNorm === dbArtistNorm;
      });

      if (candidates.length > 0) {
        for (const c of candidates) {
          console.log(`  OLD: ${t.uri} — ${t.name}`);
          console.log(`  NEW: ${c.uri} — same track, different ID`);
        }
      } else {
        console.log(`  ${t.uri} — ${t.name}: NOT found in MA at all (possibly deleted)`);
      }
    }
  }

  console.log("");
  console.log(`=== Missing URIs (in MA but NOT in DB): ${missingUris.length} ===`);
  if (missingUris.length > 0) {
    console.log("  Run POST /api/index-library to import these");
    if (missingUris.length <= 20) {
      for (const uri of missingUris.slice(0, 20)) {
        const t = maUris.get(uri)!;
        console.log(`  ${uri} — ${t.name} by ${t.artists.map(a => a.name).join(", ")}`);
      }
    }
  }

  console.log("");
  console.log("=== Verdict ===");
  const seedOk = seedUris.every((u) => maUris.has(u));
  if (seedOk && staleUris.length === 0) {
    console.log("All URIs look valid. The issue is elsewhere.");
  } else if (staleUris.length > 0) {
    console.log(`Found ${staleUris.length} stale URIs in DB. Running a full re-index should fix this.`);
    console.log("Run: curl -X POST http://localhost:3000/api/index-library");
    console.log("Note: Old stale URIs will remain in DB unless you also clean them up.");
  } else if (!seedOk) {
    console.log("Hardcoded seed URIs are stale. Update server.ts lines 85-87 with fresh seed URIs.");
  }
}

main().catch(console.error);
