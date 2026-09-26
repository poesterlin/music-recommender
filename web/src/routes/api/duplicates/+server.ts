import { applyDuplicateSkip, clearDuplicateSkip, findDuplicates } from '$lib/server/duplicates';
import type { RequestHandler } from './$types';

const MAX_KEYS = 5000;

export const GET: RequestHandler = async ({ url }) => {
	const requested = Number(url.searchParams.get('limit') ?? 200);
	const limit = Number.isFinite(requested)
		? Math.min(Math.max(Math.trunc(requested), 1), 1000)
		: 200;
	try {
		return Response.json(await findDuplicates(limit));
	} catch (error) {
		console.error('Duplicate scan failed:', error);
		return Response.json({ error: String(error) }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ request }) => {
	let body: { keys?: unknown; action?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return Response.json({ error: 'request body must be valid JSON' }, { status: 400 });
	}

	const keys = Array.isArray(body.keys)
		? body.keys.filter((k): k is string => typeof k === 'string')
		: [];
	if (keys.length === 0) {
		return Response.json({ error: 'keys must be a non-empty array' }, { status: 400 });
	}
	if (keys.length > MAX_KEYS) {
		return Response.json({ error: `at most ${MAX_KEYS} groups per request` }, { status: 400 });
	}
	if (body.action !== 'skip' && body.action !== 'restore') {
		return Response.json({ error: "action must be 'skip' or 'restore'" }, { status: 400 });
	}

	try {
		const affected =
			body.action === 'skip' ? await applyDuplicateSkip(keys) : await clearDuplicateSkip(keys);
		return Response.json({ ok: true, action: body.action, affected, groups: keys.length });
	} catch (error) {
		console.error('Duplicate cleanup failed:', error);
		return Response.json({ error: String(error) }, { status: 500 });
	}
};
