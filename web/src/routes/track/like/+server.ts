import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { trackTable } from '$lib/server/schema';
import { getCurrentTrack } from '$lib/server/webhook';
import { likeTrack } from '$lib/server/similar-track';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { uri?: string; source?: string };

	// Prefer the caller-supplied uri (the track actually displayed) so the
	// action can never drift onto whatever started playing since.
	if (typeof body.uri === 'string' && body.uri) {
		await likeTrack(body.uri, body.source || 'manual');
		const [row] = await db
			.select({ name: trackTable.name })
			.from(trackTable)
			.where(eq(trackTable.uri, body.uri));
		return Response.json({ success: true, name: row?.name ?? 'track' });
	}

	const state = await getCurrentTrack();
	if (!state) {
		return new Response('No track found', { status: 404 });
	}

	await likeTrack(state.uri, body.source || 'manual');

	return Response.json({ success: true, name: state.name });
};
