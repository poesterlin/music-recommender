import { retryStep, startSetup } from '$lib/server/setup';
import { STEP_ORDER, type StepId } from '$lib/server/setup/state';
import type { RequestHandler } from './$types';

/**
 * Drive the automatic run.
 *
 * Body is either `{"action":"start"}` to run (or continue) everything, or
 * `{"action":"retry","step":"cluster"}` to redo one step. The runner is
 * idempotent, so a double-click or a retried request cannot start a rival run.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (locals.method === 'service') {
		return Response.json({ error: 'session required' }, { status: 403 });
	}

	const body = (await request.json().catch(() => null)) as {
		action?: unknown;
		step?: unknown;
	} | null;
	const action = body?.action ?? 'start';

	if (action === 'retry') {
		const step = body?.step;
		if (typeof step !== 'string' || !STEP_ORDER.includes(step as StepId)) {
			return Response.json({ error: 'Unknown step' }, { status: 400 });
		}
		const state = await retryStep(step as StepId);
		return Response.json({ success: true, state });
	}

	if (action !== 'start') {
		return Response.json({ error: 'Unknown action' }, { status: 400 });
	}

	// Respond immediately and let the runner work. The state row is the source
	// of truth and the page polls it, so a long run outlives this request.
	const state = await startSetup({ background: true });
	return Response.json({ success: true, state });
};
