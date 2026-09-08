import { getCurrentTrack } from '$lib/server/webhook';
import { skipTrack } from '$lib/server/similar-track';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { uri?: string };

	// Prefer the caller-supplied uri (the track actually displayed) so the
	// action can never drift onto whatever started playing since.
	if (typeof body.uri === 'string' && body.uri) {
		await skipTrack(body.uri);
		return Response.json({ success: true });
	}

	const state = await getCurrentTrack();
	if (!state) {
		return new Response('No track found', { status: 404 });
	}

	await skipTrack(state.uri);

	return Response.json({ success: true });
};
