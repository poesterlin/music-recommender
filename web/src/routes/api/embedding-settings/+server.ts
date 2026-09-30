import { getEmbeddingSettings, setEmbeddingSettings, EMBEDDING_MODES } from '$lib/server/embedding-settings';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => Response.json(await getEmbeddingSettings(), {
	headers: { 'Cache-Control': 'no-store' }
});

export const PUT: RequestHandler = async ({ request, locals }) => {
	if (!locals.user || locals.method === 'service') return Response.json({ error: 'session required' }, { status: 403 });
	const body = await request.json().catch(() => null);
	if (!body || typeof body.mode !== 'string' || !Object.hasOwn(EMBEDDING_MODES, body.mode) ||
		typeof body.maxSampleSeconds !== 'number' || !Number.isFinite(body.maxSampleSeconds) ||
		body.maxSampleSeconds < 1 || body.maxSampleSeconds > 120) {
		return Response.json({ error: 'Choose low, medium or high and a sample length between 1 and 120 seconds.' }, { status: 400 });
	}
	try {
		return Response.json(await setEmbeddingSettings({ mode: body.mode, maxSampleSeconds: body.maxSampleSeconds, frontend: 'kapre' }));
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : 'Could not save embedding settings.' }, { status: 409 });
	}
};
