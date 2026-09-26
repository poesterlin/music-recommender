import { sql } from 'drizzle-orm';
import { db } from './db';
import { trackTable } from './schema';

const BATCH_SIZE = 500;
const CHUNK_SIZE = 150;

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

function normalizeArtistName(name: string): string {
	return name
		.replace(/\*/g, '')
		.replace(/_/g, '')
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/\sft\.\s/gi, ' feat. ')
		.replace(/\sft\s/gi, ' feat. ')
		.replace(/\sfeat\.\s/gi, ' feat. ')
		.replace(/\sfeat\s/gi, ' feat. ')
		.replace(/\sfeaturing\s/gi, ' feat. ')
		.replace(/with\s/gi, ' w/ ')
		.replace(/&/g, ' & ')
		.replace(/\s+/g, ' ')
		.trim();
}

function splitArtists(artistName: string): string[] {
	const normalized = normalizeArtistName(artistName);
	const parts = normalized.split(/ feat\.? | vs\.? | & |, | w\/| x | \/ | \+ | duet /);
	return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Keep only the imageproxy path from a Music Assistant cover URL.
 *
 * The upstream host is a private LAN address, so storing the full URL would
 * bake deployment-specific detail into the database and break whenever the
 * host changes. The path is stable; the host is re-applied at render time.
 */
function imageProxyPath(image: string | undefined): string | null {
	if (!image) return null;
	try {
		const url = new URL(image);
		if (!url.pathname.startsWith('/imageproxy/')) return null;
		return url.pathname;
	} catch {
		return null;
	}
}

export async function indexLibrary(): Promise<number> {
	const env = process.env;

	const authHeaders = new Headers();
	authHeaders.append('Content-Type', 'application/json');
	authHeaders.append('Authorization', 'Bearer ' + env.TOKEN);

	let offset = 0;
	let allTracks: Track[] = [];

	console.log('Fetching library tracks from external service using pagination...');

	while (true) {
		const raw = JSON.stringify({
			config_entry_id: env.CONFIG_ID,
			media_type: 'track',
			limit: BATCH_SIZE,
			offset,
			order_by: 'sort_name'
		});

		console.log(`Fetching tracks batch: offset ${offset}, limit ${BATCH_SIZE}`);

		const res = await fetch(
			env.HA_HOST + '/api/services/music_assistant/get_library?return_response',
			{ method: 'POST', headers: authHeaders, body: raw, redirect: 'follow' }
		);

		const text = await res.text();

		if (res.status !== 200) {
			console.error('Response text:', text);
			throw new Error(`HTTP ${res.status}: ${text}`);
		}

		let data: any;
		try {
			data = JSON.parse(text);
		} catch (error) {
			console.error('Failed to parse JSON response:', error);
			console.error('Response text:', text);
			throw error;
		}

		const batch = data.service_response.items;

		if (!batch || batch.length === 0) {
			console.log('No more tracks to fetch.');
			break;
		}

		allTracks.push(...batch);
		console.log(`Fetched ${batch.length} tracks. Total: ${allTracks.length}`);

		if (batch.length < BATCH_SIZE) {
			console.log('Reached end of library tracks.');
			break;
		}

		offset += BATCH_SIZE;
	}

	const tracks = allTracks.map((track: Track) => {
		const artistNames = track.artists.flatMap((artist: Artist) => splitArtists(artist.name));
		return {
			name: track.name,
			uri: track.uri,
			artist: artistNames,
			album: track.album.name,
			albumImage: imageProxyPath(track.album.image)
		} satisfies typeof trackTable.$inferInsert;
	});

	console.log(`Starting batch insert/update for ${tracks.length} tracks...`);

	for (let i = 0; i < tracks.length; i += CHUNK_SIZE) {
		const chunk = tracks.slice(i, i + CHUNK_SIZE);
		try {
			await db
				.insert(trackTable)
				.values(chunk)
				.onConflictDoUpdate({
					target: trackTable.uri,
					set: {
						artist: sql`EXCLUDED.artist`,
						album: sql`EXCLUDED.album`,
						albumImage: sql`EXCLUDED.album_image`,
						updatedAt: sql`CURRENT_TIMESTAMP`
					}
				});
			console.log(
				`Success: Chunk ${i / CHUNK_SIZE + 1} / ${Math.ceil(tracks.length / CHUNK_SIZE)}`
			);
		} catch (error) {
			console.error(`Error in chunk starting at ${i}:`, error);
		}
	}

	console.log('Finished processing tracks into the database.');
	return tracks.length;
}
