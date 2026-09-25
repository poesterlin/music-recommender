const env = process.env;

type LidarrConfig = {
	url: string;
	apiKey: string;
	rootFolderPath: string;
	qualityProfileId: number;
	metadataProfileId: number;
	monitored: boolean;
};

function lidarrConfig(): LidarrConfig {
	const url = env.LIDARR_URL?.trim().replace(/\/+$/, '');
	const apiKey = env.LIDARR_API_KEY?.trim();
	if (!url || !apiKey) {
		throw new Error('Lidarr integration is not configured');
	}

	try {
		new URL(url);
	} catch {
		throw new Error('LIDARR_URL must be a valid URL');
	}

	const qualityProfileId = Number(env.LIDARR_QUALITY_PROFILE_ID ?? '1');
	const metadataProfileId = Number(env.LIDARR_METADATA_PROFILE_ID ?? '1');
	if (!Number.isSafeInteger(qualityProfileId) || qualityProfileId < 1) {
		throw new Error('LIDARR_QUALITY_PROFILE_ID must be a positive integer');
	}
	if (!Number.isSafeInteger(metadataProfileId) || metadataProfileId < 1) {
		throw new Error('LIDARR_METADATA_PROFILE_ID must be a positive integer');
	}

	return {
		url,
		apiKey,
		rootFolderPath: env.LIDARR_ROOT_FOLDER_PATH?.trim() || '/music-ingest',
		qualityProfileId,
		metadataProfileId,
		monitored: (env.LIDARR_MONITORED ?? 'true').toLowerCase() !== 'false'
	};
}

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
        "User-Agent": "MusicRecommender/1.0 (https://github.com/poesterlin/music-recommender)",
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
    const config = lidarrConfig();
    // Step 1: Lookup the exact artist payload format from Lidarr using the MBID
    const lookupUrl = `${config.url}/api/v1/artist/lookup?term=mbid:${mbid}`;
    const lookupResponse = await fetch(lookupUrl, {
      headers: { "X-Api-Key": config.apiKey },
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
      rootFolderPath: config.rootFolderPath,
      qualityProfileId: config.qualityProfileId,
      metadataProfileId: config.metadataProfileId,
      monitored: config.monitored,
      addOptions: {
        searchForMissingAlbums: config.monitored,
      },
    };

    // Step 3: POST the complete payload to add the artist
    const addUrl = `${config.url}/api/v1/artist`;
    const addResponse = await fetch(addUrl, {
      method: "POST",
      headers: {
        "X-Api-Key": config.apiKey,
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
