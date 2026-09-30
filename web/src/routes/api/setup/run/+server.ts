import { getSetupState, runSetupStep } from '$lib/server/setup';
import { STEP_ORDER, type StepId } from '$lib/server/setup/state';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (locals.method === 'service') {
		return Response.json({ error: 'session required' }, { status: 403 });
	}
	const body = await request.json().catch(() => null);
	const step = body?.step;
	if (
		typeof step !== 'string' ||
		!STEP_ORDER.includes(step as StepId) ||
		['embed', 'covers'].includes(step)
	) {
		return Response.json({ error: 'Unknown setup action' }, { status: 400 });
	}
	if (!runSetupStep(step as StepId)) {
		return Response.json({ error: 'A setup action is already running' }, { status: 409 });
	}
	return Response.json({ success: true, state: await getSetupState() });
};
