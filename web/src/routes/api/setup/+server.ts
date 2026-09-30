import { getSetupState } from '$lib/server/setup';
import { needsSetup } from '$lib/server/setup/state';
import type { RequestHandler } from './$types';

/**
 * Read-only live setup checklist and current operation.
 */
export const GET: RequestHandler = async ({ locals }) => {
	// Setup is an authenticated operator page. Sessions only.
	if (locals.method === 'service') {
		return Response.json({ error: 'session required' }, { status: 403 });
	}
	const state = await getSetupState();
	return Response.json({ success: true, state, needed: await needsSetup() });
};
