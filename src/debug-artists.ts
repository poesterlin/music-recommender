import { artists } from "./artists";

const env = process.env;

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

const artistGroups = new Map<string, { count: number; tracks: string[] }>();

for (const track of response.tracks) {
  const artistNames = track.artists.map((artist) => artist.name);
  for (const artistName of artistNames) {
    const splitArtistNames = splitArtists(artistName);
    for (const singleArtist of splitArtistNames) {
      if (!artistGroups.has(singleArtist)) {
        artistGroups.set(singleArtist, { count: 0, tracks: [] });
      }
      const group = artistGroups.get(singleArtist)!;
      group.count++;
      group.tracks.push(track.name);
    }
  }
}

const sortedArtists = Array.from(artistGroups.entries()).sort((a, b) => 
  b[1].count - a[1].count
);

const normalizedTrackedArtists = new Set(artists.map(normalizeArtistName));
const trackedInLibrary = sortedArtists.filter(([artist]) => normalizedTrackedArtists.has(artist));
const untrackedInLibrary = sortedArtists.filter(([artist]) => !normalizedTrackedArtists.has(artist));

const trackedButNotInLibrary = artists.filter(artist => !normalizedTrackedArtists.has(normalizeArtistName(artist)));

console.log("\n" + "═".repeat(80));
console.log("🎵  MUSIC ASSISTANT LIBRARY ANALYSIS");
console.log("═".repeat(80) + "\n");

console.log("📊  OVERVIEW");
console.log("─".repeat(80));
console.log(`  Total unique artists in library:   ${sortedArtists.length}`);
console.log(`  Tracked artists in library:         ${trackedInLibrary.length}`);
console.log(`  Untracked artists in library:       ${untrackedInLibrary.length}`);
console.log(`  Tracked artists missing from lib:   ${trackedButNotInLibrary.length}`);
console.log("");

console.log("✅  TRACKED ARTISTS IN LIBRARY");
console.log("─".repeat(80));
trackedInLibrary.slice(0, 20).forEach(([artist, { count, tracks }]) => {
  console.log(`  ✓ ${artist.padEnd(30)} ${count.toString().padStart(4)} tracks`);
});
if (trackedInLibrary.length > 20) {
  console.log(`  ... and ${trackedInLibrary.length - 20} more`);
}
console.log("");

console.log("❌  UNTRACKED ARTISTS IN LIBRARY (TOP 30)");
console.log("─".repeat(80));
untrackedInLibrary.slice(0, 30).forEach(([artist, { count, tracks }]) => {
  console.log(`  ✗ ${artist.padEnd(30)} ${count.toString().padStart(4)} tracks`);
  console.log(`     Sample: ${tracks.slice(0, 2).join(", ")}`);
});
if (untrackedInLibrary.length > 30) {
  console.log(`  ... and ${untrackedInLibrary.length - 30} more`);
}
console.log("");

if (trackedButNotInLibrary.length > 0) {
  console.log("⚠️  TRACKED ARTISTS MISSING FROM LIBRARY");
  console.log("─".repeat(80));
  trackedButNotInLibrary.slice(0, 20).forEach(artist => {
    console.log(`  ! ${artist}`);
  });
  if (trackedButNotInLibrary.length > 20) {
    console.log(`  ... and ${trackedButNotInLibrary.length - 20} more`);
  }
  console.log("");
}

console.log("🏆  TOP 10 MOST POPULAR ARTISTS");
console.log("─".repeat(80));
sortedArtists.slice(0, 10).forEach(([artist, { count }], index) => {
  const medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : "  ";
  console.log(`  ${medal} ${artist.padEnd(30)} ${count.toString().padStart(4)} tracks`);
});
console.log("");

console.log("═".repeat(80) + "\n");

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
