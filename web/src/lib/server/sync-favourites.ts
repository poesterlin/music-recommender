import { db } from './db';
import { scanLibrary } from './ma-library';
import { likedSongsTable } from './schema';

/** Favourites are a small slice of the library, so a modest page is plenty. */
const PAGE_SIZE = 500;
/** Rows per multi-row insert. Large enough to amortise, small enough to stay cheap. */
const CHUNK_SIZE = 150;

/**
 * Mirror Music Assistant's favourites into the liked-songs table.
 *
 * `favorite: true` is a server-side filter, so only favourites cross the wire
 * rather than the whole library minus the rows to skip. Music Assistant's
 * `count` command silently ignores the same filter, so the scan is paged to
 * exhaustion instead of counting first.
 *
 * Returns the number of favourites seen, whether or not each one was newly
 * inserted — the table is deduplicated by URI, so a re-sync legitimately
 * writes nothing new.
 */
export async function syncFavorites(): Promise<number> {
	let seen = 0;

	console.log('Fetching favorite tracks from Music Assistant...');

	await scanLibrary({ favorite: true, limit: PAGE_SIZE }, async (items) => {
		const rows = items
			.filter((track): track is typeof track & { uri: string } => Boolean(track?.uri))
			.map((track) => ({ uri: track.uri, source: 'sync-favorites' }));
		if (rows.length === 0) return;
		seen += rows.length;

		for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
			const chunk = rows.slice(i, i + CHUNK_SIZE);
			try {
				await db.insert(likedSongsTable).values(chunk).onConflictDoNothing();
			} catch (error) {
				// Keep going: a failed chunk should not abandon the remaining
				// favourites, but it must be visible in the log.
				console.error(`[sync-favorites] chunk at offset ${i} failed:`, error);
			}
		}
	});

	console.log(`Finished syncing favorite tracks: ${seen}`);
	return seen;
}
