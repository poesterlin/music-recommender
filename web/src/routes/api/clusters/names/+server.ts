import { applyAutoNames, suggestClusterNames } from '$lib/server/cluster-naming';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	try {
		return Response.json({ suggestions: await suggestClusterNames() });
	} catch (error) {
		console.error('[cluster-naming] suggest failed:', error);
		return Response.json({ error: String(error) }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	// Renaming the whole library is not something the scheduled jobs should be
	// able to trigger, so the worker token is refused here.
	if (locals.method === 'service') {
		return Response.json({ error: 'auto-naming requires a signed-in session' }, { status: 403 });
	}

	let body: { clusterIds?: unknown; onlyUnnamed?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return Response.json({ error: 'request body must be valid JSON' }, { status: 400 });
	}

	try {
		let ids: number[] = [];
		if (Array.isArray(body.clusterIds)) {
			ids = body.clusterIds.filter(
				(id): id is number => typeof id === 'number' && Number.isInteger(id) && id >= 0
			);
		} else if (body.onlyUnnamed === true) {
			ids = (await suggestClusterNames()).filter((s) => !s.named).map((s) => s.clusterId);
		} else {
			return Response.json({ error: 'provide clusterIds or onlyUnnamed' }, { status: 400 });
		}

		const named = await applyAutoNames(ids);
		return Response.json({ ok: true, named });
	} catch (error) {
		console.error('[cluster-naming] apply failed:', error);
		return Response.json({ error: String(error) }, { status: 500 });
	}
};
