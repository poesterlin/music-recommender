import { runIndexLibrary, sourceFor } from '$lib/server/jobs';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals }) => {
	const result = await runIndexLibrary(sourceFor(locals.method));
	if (!result.ok) {
		return Response.json({ success: false, error: result.error }, { status: 500 });
	}
	const { fetched, added, existing, failed } = result.data;
	return Response.json({ success: failed === 0, fetched, added, existing, failed });
};
