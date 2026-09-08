const env = process.env;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ==========================================
// CONFIGURATION - UPDATE THESE VALUES
// ==========================================
const LIDARR_URL = env.LIDARR_URL ?? "http://100.82.130.136:8686"; // e.g., http://192.168.1.50:8686
const LIDARR_API_KEY = env.LIDARR_API_KEY ?? "2bcd31d0066644629ba7d227ed89a871";
const ROOT_FOLDER_PATH = env.LIDARR_ROOT_FOLDER_PATH ?? "/music-ingest"; // e.g., /data/media/music
const QUALITY_PROFILE_ID = Number(env.LIDARR_QUALITY_PROFILE_ID ?? "1");
const METADATA_PROFILE_ID = Number(env.LIDARR_METADATA_PROFILE_ID ?? "1");
const MONITORED = (env.LIDARR_MONITORED ?? "true") === "true";

// Add your list of artists here
export const ARTISTS_TO_ADD = [
  "Isaiah Rashad",
  "Smino",
  "Joey Bada$$",
  "EarthGang",
  "Brent Faiyaz",
  "Omar Apollo",
  "Sampha",
  "PinkPantheress",
  "Kaytranada",
  "Bicep",
  "Odesza",
  "Feid",
  "Young Miko",
  "Chappell Roan",
  "Reneé Rapp",
  "Tyla",
  "Carly Rae Jepsen",
  "Sigrid",
  "Griff",
  "Conan Gray",
  "Gracie Abrams",
  "Remi Wolf",
  "Joy Crookes",
  "Cleo Sol",
  "Raveena",
  "Olivia Dean",
  "Susanne Sundfør",
  "RY X",
  "Novo Amor",
  "Ethel Cain",
];
// ==========================================

type LidarrAddResult = {
  success: boolean;
  alreadyExists?: boolean;
  artist: string;
  mbid?: string;
  message: string;
  error?: unknown;
};

type MusicBrainzArtist = { id: string };
type MusicBrainzResponse = { artists?: MusicBrainzArtist[] };
type LidarrLookupArtist = { id?: number } & Record<string, unknown>;

export async function getMusicBrainzId(artistName: string): Promise<string | null> {
  const url = new URL("https://musicbrainz.org/ws/2/artist/");
  url.searchParams.append("query", `artist:"${artistName}"`);
  url.searchParams.append("fmt", "json");

  try {
    const response = await fetch(url.toString(), {
      headers: {
        "User-Agent": "LidarrBunImporter/1.0 ( me@example.com )",
      },
    });

    if (!response.ok) {
      console.error(`❌ MB API Error for ${artistName}: ${response.status}`);
      return null;
    }

    const data = await response.json() as MusicBrainzResponse;
    if (data.artists && data.artists.length > 0) {
      // Taking the first result as the most relevant match
      return data.artists[0].id;
    }

    console.log(`⚠️ No MusicBrainz match found for: ${artistName}`);
    return null;
  } catch (error) {
    console.error(`❌ Failed to fetch MBID for ${artistName}:`, error);
    return null;
  }
}

export async function addArtistToLidarr(artistName: string, mbid: string): Promise<LidarrAddResult> {
  try {
    // Step 1: Lookup the exact artist payload format from Lidarr using the MBID
    const lookupUrl = `${LIDARR_URL}/api/v1/artist/lookup?term=mbid:${mbid}`;
    const lookupResponse = await fetch(lookupUrl, {
      headers: { "X-Api-Key": LIDARR_API_KEY },
    });

    if (!lookupResponse.ok) {
      const message = `Lidarr lookup failed for ${artistName}`;
      console.error(`❌ ${message}`);
      return { success: false, artist: artistName, mbid, message };
    }

    const lookupData = await lookupResponse.json() as LidarrLookupArtist[];

    if (!lookupData || lookupData.length === 0) {
      const message = `Lidarr couldn't find artist by MBID: ${mbid}`;
      console.log(`⚠️ ${message}`);
      return { success: false, artist: artistName, mbid, message };
    }

    // Step 2: Format the payload by adding required local path/profile configurations
    const artistPayload = lookupData[0];

    // Check if they are already in Lidarr
    if (artistPayload.id) {
      const message = `${artistName} is already in Lidarr`;
      console.log(`✅ ${message}.`);
      return { success: true, alreadyExists: true, artist: artistName, mbid, message };
    }

    const payload = {
      ...artistPayload,
      rootFolderPath: ROOT_FOLDER_PATH,
      qualityProfileId: QUALITY_PROFILE_ID,
      metadataProfileId: METADATA_PROFILE_ID,
      monitored: MONITORED,
      addOptions: {
        searchForMissingAlbums: MONITORED,
      },
    };

    // Step 3: POST the complete payload to add the artist
    const addUrl = `${LIDARR_URL}/api/v1/artist`;
    const addResponse = await fetch(addUrl, {
      method: "POST",
      headers: {
        "X-Api-Key": LIDARR_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (addResponse.ok) {
      const message = `Successfully added ${artistName} to Lidarr`;
      console.log(`🎉 ${message}!`);
      return { success: true, artist: artistName, mbid, message };
    } else {
      const errorData = await addResponse.json();
      console.error(`❌ Failed to add ${artistName}:`, errorData);
      return {
        success: false,
        artist: artistName,
        mbid,
        message: `Failed to add ${artistName}`,
        error: errorData,
      };
    }
  } catch (error) {
    console.error(`❌ Error communicating with Lidarr for ${artistName}:`, error);
    return {
      success: false,
      artist: artistName,
      mbid,
      message: `Error communicating with Lidarr for ${artistName}`,
      error,
    };
  }
}

export async function addArtistByNameToLidarr(artistName: string): Promise<LidarrAddResult> {
  const mbid = await getMusicBrainzId(artistName);
  if (!mbid) {
    return {
      success: false,
      artist: artistName,
      message: `No MusicBrainz match found for ${artistName}`,
    };
  }

  return addArtistToLidarr(artistName, mbid);
}

export async function importArtistsToLidarr(
  artists: string[],
  delayMs = 1500,
): Promise<{ success: number; failed: number; results: LidarrAddResult[] }> {
  const results: LidarrAddResult[] = [];

  for (const artist of artists) {
    const result = await addArtistByNameToLidarr(artist);
    results.push(result);
    await sleep(delayMs);
  }

  return {
    success: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  };
}

// async function main() {
//   console.log("Starting Lidarr Artist Import...\n");

//   for (const artist of ARTISTS_TO_ADD) {
//     console.log(`Processing: ${artist}...`);
    
//     const mbid = await getMusicBrainzId(artist);
    
//     if (mbid) {
//       await addArtistToLidarr(artist, mbid);
//     }

//     // STRICT RATE LIMIT: MusicBrainz allows 1 request per second.
//     // Do not lower this, or your IP will get temporarily banned.
//     await sleep(1500);
//   }

//   console.log("\nFinished importing artists.");
// }

// main();
