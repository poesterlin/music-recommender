import { syncFavorites } from '$lib/server/sync-favourites';
import { recordJobRun } from '$lib/server/job-log';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals }) => {
	const source = locals.method === 'service' ? 'automatic' : 'manual';
	try {
		const count = await syncFavorites();
		await recordJobRun('sync-favorites', true, `${count} liked songs`, source);
		return Response.json({ success: true, count });
	} catch (error) {
		console.error('Sync favorites failed:', error);
		await recordJobRun('sync-favorites', false, String(error).slice(0, 200), source);
		return Response.json({ success: false, error: String(error) }, { status: 500 });
	}
};
