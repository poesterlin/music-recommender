import { sql } from 'drizzle-orm';
import { db } from './db';
import { imageProxyPath, scanLibrary, type MaTrack } from './ma-library';
import { trackTable } from './schema';

/**
 * Measured against Music Assistant's `library_items`, throughput is flat to
 * 2000 per request: 500 costs ~0.4ms/item, 2000 ~0.15ms/item, 5000 ~0.17ms/item.
 * Going much larger stops helping and makes a dropped request costly to retry.
 */
const PAGE_SIZE = 2000;
/** Rows per multi-row insert. Large enough to amortise, small enough to stay cheap. */
const CHUNK_SIZE = 150;

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

type Staged = typeof trackTable.$inferInsert;

function stage(track: MaTrack): Staged | null {
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
		WHERE uri IN ${uris}
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
	const result: IndexResult = { fetched: 0, added: 0, existing: 0, failed: 0 };

	await scanLibrary({ limit: PAGE_SIZE }, async (items, offset) => {
		const staged = items.map(stage).filter((row): row is Staged => row !== null);
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
	});

	console.log(
		`[index-library] fetched ${result.fetched}, new ${result.added}, already indexed ${result.existing}, failed ${result.failed}`
	);
	return result;
}
