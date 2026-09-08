import { syncFavorites } from '$lib/server/sync-favourites';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
	try {
		const count = await syncFavorites();
		return Response.json({ success: true, count });
	} catch (error) {
		console.error('Sync favorites failed:', error);
		return Response.json({ success: false, error: String(error) }, { status: 500 });
	}
};
