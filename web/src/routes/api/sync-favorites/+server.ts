import { runSyncFavorites, sourceFor } from '$lib/server/jobs';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals }) => {
	const result = await runSyncFavorites(sourceFor(locals.method));
	if (!result.ok) {
		return Response.json({ success: false, error: result.error }, { status: 500 });
	}
	return Response.json({ success: true, count: result.data });
};
