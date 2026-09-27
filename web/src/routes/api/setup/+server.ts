import { getSetupState } from '$lib/server/setup';
import { needsSetup } from '$lib/server/setup/state';
import type { RequestHandler } from './$types';

/**
 * Current setup progress. Polled by the wizard while a run is in progress or
 * paused waiting on the embedding worker.
 */
export const GET: RequestHandler = async ({ locals }) => {
	// Setup writes to the database, so the worker token must not be able to
	// drive it. Sessions only.
	if (locals.method === 'service') {
		return Response.json({ error: 'session required' }, { status: 403 });
	}
	const state = await getSetupState();
	return Response.json({ success: true, state, needed: await needsSetup() });
};
