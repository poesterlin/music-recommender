import { sql } from "drizzle-orm";
import { db } from "./db";
import { trackTable } from "./schema";

const env = process.env;

const authHeaders = new Headers();
authHeaders.append("Content-Type", "application/json");
authHeaders.append("Authorization", "Bearer " + env.TOKEN);

const raw = JSON.stringify({
  limit: "100000",
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

function normalizeArtistName(name: string): string {
  return name
    .replace(/\*/g, "")
    .replace(/_/g, "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\sft\.\s/gi, " feat. ")
    .replace(/\sft\s/gi, " feat. ")
    .replace(/\sfeat\.\s/gi, " feat. ")
    .replace(/\sfeat\s/gi, " feat. ")
    .replace(/\sfeaturing\s/gi, " feat. ")
    .replace(/with\s/gi, " w/ ")
    .replace(/&/g, " & ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitArtists(artistName: string): string[] {
  const normalized = normalizeArtistName(artistName);
  const parts = normalized.split(/ feat\.? | vs\.? | & |, | w\/| x | \/ | \+ | duet /);
  return parts.map(p => p.trim()).filter(p => p.length > 0);
}

const tracks = response.tracks.map((track) => {
  const artistNames = track.artists.flatMap((artist) => splitArtists(artist.name));
  
  return {
    name: track.name,
    uri: track.uri,
    artist: artistNames,
    album: track.album.name,
  } satisfies typeof trackTable.$inferInsert;
});

const result = await db.insert(trackTable).values(tracks).onConflictDoUpdate({
  target: trackTable.uri,
  set: {
    // name: sql`EXCLUDED.name`,
    artist: sql`EXCLUDED.artist`,
    // album: sql`EXCLUDED.album`,
    updatedAt: sql`CURRENT_TIMESTAMP`,
  },
});

console.log(result, `Inserted new tracks into the database.`);

type LibraryResponse = {
  service_response: ServiceResponse;
};

interface ServiceResponse {
  artists: Artist[];
  albums: Album[];
  tracks: Track[];
  playlists: Playlist[];
  radio: Radio[];
  audiobooks: any[];
  podcasts: any[];
}

interface Artist {
  media_type: string;
  uri: string;
  name: string;
  version: string;
  image?: string;
}

interface Album {
  media_type: string;
  uri: string;
  name: string;
  version: string;
  image: string;
  artists: Artist[];
}

interface Track {
  media_type: string;
  uri: string;
  name: string;
  version: string;
  image: string;
  artists: Artist[];
  album: Album;
}

interface Playlist {
  media_type: string;
  uri: string;
  name: string;
  version: string;
  image?: string;
}

interface Radio {
  media_type: string;
  uri: string;
  name: string;
  version: string;
  image: string;
}
