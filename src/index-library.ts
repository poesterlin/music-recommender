import { artists } from "./artists";
import { db } from "./db";
import { trackTable } from "./schema";

const env = process.env;

const authHeaders = new Headers();
authHeaders.append("Content-Type", "application/json");
authHeaders.append("Authorization", "Bearer " + env.TOKEN);

const raw = JSON.stringify({
  limit: "10000",
  library_only: "true",
  config_entry_id: env.CONFIG_ID,
  name: "",
  media_type: "track",
});

const res = await fetch(
  env.HOST + "/api/services/music_assistant/search?return_response",
  {
    method: "POST",
    headers: authHeaders,
    body: raw,
    redirect: "follow",
  }
);

const data = (await res.json()) as LibraryResponse;

const response = data.service_response;
const tracks = response.tracks.map((track) => {
  const artists = getArtists(
    track.artists.map((artist) => artist.name).join(", ")
  );
  return {
    id: track.uri,
    name: track.name,
    uri: track.uri,
    artists: artists,
    album: track.album.name,
  };
});

await db.insert(trackTable).values(tracks).onConflictDoNothing();

function getArtists(input: string) {
  const found = [];
  for (const artist of artists) {
    if (input.includes(artist)) {
      found.push(artist);
    }
  }

  return found;
}
