import { getCurrentTrack } from '$lib/server/webhook';
import { likeTrack } from '$lib/server/similar-track';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => ({}));
	const state = await getCurrentTrack();
	if (!state) {
		return new Response('No track found', { status: 404 });
	}

	await likeTrack(state.uri, (body as any).source || 'manual');

	return Response.json({ success: true, name: state.name });
};
