import { syncFavorites } from '$lib/server/sync-favourites';
import { recordJobRun } from '$lib/server/job-log';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
	try {
		const count = await syncFavorites();
		await recordJobRun('sync-favorites', true, `${count} liked songs`);
		return Response.json({ success: true, count });
	} catch (error) {
		console.error('Sync favorites failed:', error);
		await recordJobRun('sync-favorites', false, String(error).slice(0, 200));
		return Response.json({ success: false, error: String(error) }, { status: 500 });
	}
};
