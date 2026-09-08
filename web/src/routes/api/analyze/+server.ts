import { indexLibrary } from '$lib/server/index-library';
import { recordJobRun } from '$lib/server/job-log';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
	try {
		// 0. Ask Music Assistant to sync its providers (e.g. Plex) so new
		// downloads show up. Skipped (not failed) when MA_TOKEN is unset.
		let maSync: unknown = { skipped: true };
		if (process.env.MA_TOKEN) {
			const { triggerLibrarySync } = await import('$lib/server/ma-sync');
			maSync = await triggerLibrarySync();
		} else {
			console.warn('[analyze] MA_TOKEN not set, skipping MA library sync');
		}
		// 1. Pull new tracks from Music Assistant (no embeddings yet)
		const indexed = await indexLibrary();
		// 2. Assign embedded-but-unclustered tracks to frozen centroids.
		// Existing cluster_ids are never touched. Audio embedding
		// generation itself runs in the embeddings-loop container.
		const { assignNewTracksToClusters } = await import('$lib/server/clustering');
		const assigned = await assignNewTracksToClusters();
		await recordJobRun('analyze', true, `${indexed} indexed, ${assigned} sorted into vibes`);
		return Response.json({ success: true, maSync, indexed, assigned });
	} catch (error) {
		console.error('Analyze failed:', error);
		await recordJobRun('analyze', false, String(error).slice(0, 200));
		return Response.json({ success: false, error: String(error) }, { status: 500 });
	}
};
