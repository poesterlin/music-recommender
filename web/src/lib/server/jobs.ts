/**
 * The body of each maintenance job, shared by the HTTP routes and the
 * in-process scheduler.
 *
 * Keeping them here means a job triggered by a button on the Manage page and
 * the same job on its timer execute identical code and record identical rows in
 * `job_run`; only the recorded `source` differs. The routes used to own this
 * logic inline, which meant a scheduled run had to reach back into the app over
 * HTTP just to reuse it.
 */

import type { AuthMethod } from './auth';
import { indexLibrary, type IndexResult } from './index-library';
import { recordJobRun, type JobSource } from './job-log';
import { syncFavorites } from './sync-favourites';

export type JobResult<T> =
	{ ok: true; data: T; detail: string } | { ok: false; error: string; detail: string };

/**
 * The recorded source for a request: a service token means something triggered
 * this without a signed-in user, a session means the Manage page did.
 */
export function sourceFor(method: AuthMethod | null | undefined): JobSource {
	return method === 'service' ? 'automatic' : 'manual';
}

function failure(job: string, error: unknown, source: JobSource): JobResult<never> {
	const message = String((error as Error)?.message ?? error);
	console.error(`[${job}] failed:`, error);
	void recordJobRun(job, false, message.slice(0, 200), source);
	return { ok: false, error: message, detail: message.slice(0, 200) };
}

/** Pull the track list from Music Assistant and upsert what changed. */
export async function runIndexLibrary(source: JobSource): Promise<JobResult<IndexResult>> {
	try {
		const result = await indexLibrary();
		// Report what actually changed rather than the library size, so a
		// routine run is distinguishable from a real import.
		const summary =
			result.added > 0
				? `${result.added} new`
				: `no new tracks, ${result.existing} already indexed`;
		const detail = result.failed
			? `${summary}, ${result.failed} tracks failed to import; retry indexing`
			: summary;
		await recordJobRun('index-library', result.failed === 0, detail, source);
		if (result.failed) return { ok: false, error: detail, detail };
		return { ok: true, data: result, detail };
	} catch (error) {
		return failure('index-library', error, source);
	}
}

/** Mirror Music Assistant favourites into the liked-songs table. */
export async function runSyncFavorites(source: JobSource): Promise<JobResult<number>> {
	try {
		const count = await syncFavorites();
		const detail = `${count} liked songs`;
		await recordJobRun('sync-favorites', true, detail, source);
		return { ok: true, data: count, detail };
	} catch (error) {
		return failure('sync-favorites', error, source);
	}
}

/**
 * Ask Music Assistant to pull new downloads, index them, then file the
 * embedded ones into the frozen clusters.
 *
 * Cluster assignment only ever touches tracks that have no cluster yet, so
 * running this repeatedly is safe and an existing vibe is never reshuffled.
 */
export async function runAnalyze(
	source: JobSource
): Promise<JobResult<{ maSync: unknown; indexed: number; assigned: number }>> {
	try {
		// 0. Ask Music Assistant to sync its providers (e.g. Plex) so new
		// downloads show up. Skipped (not failed) when MA_TOKEN is unset.
		let maSync: unknown = { skipped: true };
		if (process.env.MA_TOKEN) {
			const { triggerLibrarySync } = await import('./ma-sync');
			maSync = await triggerLibrarySync();
		} else {
			console.warn('[analyze] MA_TOKEN not set, skipping MA library sync');
		}
		// 1. Pull new tracks from Music Assistant (no embeddings yet)
		const { added, failed } = await indexLibrary();
		if (failed)
			return failure(
				'analyze',
				new Error(`${added} new tracks indexed, ${failed} tracks failed to import; retry indexing`),
				source
			);
		// 2. Assign embedded-but-unclustered tracks to frozen centroids.
		// Audio embedding generation itself runs in the embeddings container.
		const { assignNewTracksToClusters } = await import('./clustering');
		const assigned = await assignNewTracksToClusters();
		const detail = `${added} indexed, ${assigned} sorted into vibes`;
		await recordJobRun('analyze', true, detail, source);
		return { ok: true, data: { maSync, indexed: added, assigned }, detail };
	} catch (error) {
		return failure('analyze', error, source);
	}
}
