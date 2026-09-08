import { getCurrentTrack } from '$lib/server/webhook';
import { skipTrack } from '$lib/server/similar-track';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const state = await getCurrentTrack();
	if (!state) {
		return new Response('No track found', { status: 404 });
	}

	await skipTrack(state.uri);

	return Response.json({ success: true });
};
