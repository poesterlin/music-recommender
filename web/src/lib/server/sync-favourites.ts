import { db } from "./db";
import { likedSongsTable } from "./schema";

const BATCH_SIZE = 500;
const CHUNK_SIZE = 150;

interface Track {
  media_type: string;
  uri: string;
  name: string;
  version: string;
  image: string;
  artists: { media_type: string; uri: string; name: string; version: string; image?: string }[];
  album: { media_type: string; uri: string; name: string; version: string; image: string; artists: any[] };
}

export async function syncFavorites(): Promise<number> {
  const env = process.env;

  const authHeaders = new Headers();
  authHeaders.append("Content-Type", "application/json");
  authHeaders.append("Authorization", "Bearer " + env.TOKEN);

  let offset = 0;
  let allTracks: Track[] = [];

  console.log("Fetching favorite tracks from Music Assistant...");

  while (true) {
    const raw = JSON.stringify({
      config_entry_id: env.CONFIG_ID,
      media_type: "track",
      limit: BATCH_SIZE,
      offset,
      favorite: true,
      album_artists_only: false,
    });

    console.log(`Fetching favorites batch: offset ${offset}, limit ${BATCH_SIZE}`);

    const res = await fetch(
      env.HOST + "/api/services/music_assistant/get_library?return_response",
      { method: "POST", headers: authHeaders, body: raw, redirect: "follow" }
    );

    const text = await res.text();

    if (res.status !== 200) {
      console.error("Response text:", text);
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    let data: any;
    try {
      data = JSON.parse(text);
    } catch (error) {
      console.error("Failed to parse JSON response:", error);
      console.error("Response text:", text);
      throw error;
    }

    const batch = data.service_response.items;

    if (!batch || batch.length === 0) {
      console.log("No more tracks to fetch.");
      break;
    }

    allTracks.push(...batch);
    console.log(`Fetched ${batch.length} tracks. Total: ${allTracks.length}`);

    if (batch.length < BATCH_SIZE) {
      console.log("Reached end of favorite tracks.");
      break;
    }

    offset += BATCH_SIZE;
  }

  const rows = allTracks.map((track) => ({
    uri: track.uri,
    source: "sync-favorites",
  }));

  console.log(`Inserting ${rows.length} favorite tracks into liked_songs...`);

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    try {
      await db.insert(likedSongsTable).values(chunk).onConflictDoNothing();
      console.log(`Success: Chunk ${i / CHUNK_SIZE + 1} / ${Math.ceil(rows.length / CHUNK_SIZE)}`);
    } catch (error) {
      console.error(`Error in chunk starting at ${i}:`, error);
    }
  }

  console.log("Finished syncing favorite tracks.");
  return rows.length;
}
