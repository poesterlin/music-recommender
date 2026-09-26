import { sql } from 'drizzle-orm';
import { db } from './db';
import { trackTable } from './schema';

/**
 * Measured against Music Assistant, per-item cost is lowest around 2000 per
 * page: 500 costs ~0.38ms/item, 2000 ~0.26ms/item, 5000 ~0.51ms/item because
 * the payload stops amortising the round trip.
 */
const PAGE_SIZE = 2000;
/** Rows per multi-row insert. Large enough to amortise, small enough to stay cheap. */
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
	album?: Album | null;
}

export type IndexResult = {
	/** Rows the library reported. */
	fetched: number;
	/** URIs not previously known; these are genuine additions. */
	added: number;
	/** URIs already present. Metadata may or may not have changed. */
	existing: number;
	/** Chunks that failed to write. */
	failed: number;
};

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
		.replace(/\sfeating\s/gi, ' feat. ')
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

type Staged = typeof trackTable.$inferInsert;

function stage(track: Track): Staged | null {
	// A track with no uri cannot be upserted, and a track with no artists is
	// not something the rest of the app can reason about. Skip both rather
	// than letting one malformed item abort a whole page.
	if (!track?.uri) return null;
	const artists = (track.artists ?? []).flatMap((artist) => splitArtists(artist.name ?? ''));
	return {
		name: track.name ?? '',
		uri: track.uri,
		// The dedup and clustering rules key on artist[1], so an empty array
		// would make such tracks permanently unmatchable.
		artist: artists.length > 0 ? artists : ['Unknown Artist'],
		album: track.album?.name ?? '',
		albumImage: imageProxyPath(track.album?.image)
	};
}

/** How many of these uris the database already knows about. */
async function countExisting(rows: Staged[]): Promise<number> {
	if (rows.length === 0) return 0;
	const uris = rows.map((row) => row.uri);
	const existing = (await db.execute(sql`
		SELECT count(*)::int AS n
		FROM track
		WHERE uri = ANY(${uris}::text[])
	`)) as unknown as Array<{ n: number }>;
	return Number(existing[0]?.n ?? 0);
}

/**
 * Index the library from Music Assistant.
 *
 * Pages are written as they arrive rather than buffered, so memory stays flat
 * regardless of library size, and rows whose metadata has not changed are left
 * alone. That last part matters: bumping `updated_at` on every row every run
 * made "last write" on the status page meaningless and rewrote the entire
 * table several times a day for no information.
 *
 * `skip` is deliberately not in the conflict set, so a manual skip or a
 * duplicate cleanup survives re-indexing.
 */
export async function indexLibrary(): Promise<IndexResult> {
	const env = process.env;
	const result: IndexResult = { fetched: 0, added: 0, existing: 0, failed: 0 };

	const authHeaders = new Headers();
	authHeaders.append('Content-Type', 'application/json');
	authHeaders.append('Authorization', 'Bearer ' + (env.TOKEN ?? ''));

	let offset = 0;
	while (true) {
		const res = await fetch(
			`${env.HA_HOST}/api/services/music_assistant/get_library?return_response`,
			{
				method: 'POST',
				headers: authHeaders,
				redirect: 'follow',
				body: JSON.stringify({
					config_entry_id: env.CONFIG_ID,
					media_type: 'track',
					limit: PAGE_SIZE,
					offset,
					order_by: 'sort_name'
				})
			}
		);

		if (res.status !== 200) {
			const text = await res.text();
			throw new Error(
				`HTTP ${res.status} fetching library page at offset ${offset}: ${text.slice(0, 200)}`
			);
		}

		let items: unknown;
		try {
			items = (JSON.parse(await res.text()) as { service_response?: { items?: unknown } })
				.service_response?.items;
		} catch (error) {
			throw new Error(`library page at offset ${offset} was not valid JSON: ${String(error)}`);
		}
		if (!Array.isArray(items)) {
			throw new Error(`library page at offset ${offset} had no items array`);
		}
		if (items.length === 0) break;

		const staged = (items as Track[]).map(stage).filter((row): row is Staged => row !== null);
		result.fetched += items.length;

		for (let i = 0; i < staged.length; i += CHUNK_SIZE) {
			const chunk = staged.slice(i, i + CHUNK_SIZE);
			try {
				const known = await countExisting(chunk);
				result.existing += known;
				result.added += chunk.length - known;
				await db
					.insert(trackTable)
					.values(chunk)
					.onConflictDoUpdate({
						target: trackTable.uri,
						set: {
							name: sql`EXCLUDED.name`,
							artist: sql`EXCLUDED.artist`,
							album: sql`EXCLUDED.album`,
							albumImage: sql`EXCLUDED.album_image`,
							updatedAt: sql`CURRENT_TIMESTAMP`
						},
						// Only rewrite a row that genuinely differs. Without this
						// every run touches every row and `updated_at` stops
						// meaning "this track changed".
						setWhere: sql`
							track.name IS DISTINCT FROM EXCLUDED.name
							OR track.artist IS DISTINCT FROM EXCLUDED.artist
							OR track.album IS DISTINCT FROM EXCLUDED.album
							OR track.album_image IS DISTINCT FROM EXCLUDED.album_image
						`
					});
			} catch (error) {
				// Record the failure and keep going so one bad chunk does not
				// abandon the rest of the library, but report it honestly.
				result.failed += chunk.length;
				console.error(`[index-library] chunk at offset ${offset + i} failed:`, error);
			}
		}

		if (items.length < PAGE_SIZE) break;
		offset += PAGE_SIZE;
	}

	console.log(
		`[index-library] fetched ${result.fetched}, new ${result.added}, already indexed ${result.existing}, failed ${result.failed}`
	);
	return result;
}
