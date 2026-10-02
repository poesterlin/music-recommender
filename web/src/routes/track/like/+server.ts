import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { trackTable, likedSongsTable } from '$lib/server/schema';
import { getCurrentTrack } from '$lib/server/webhook';
import { likeTrack } from '$lib/server/similar-track';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const uri = url.searchParams.get('uri');
	if (!uri) return Response.json({ error: 'uri is required' }, { status: 400 });
	const [row] = await db.select({ uri: likedSongsTable.uri }).from(likedSongsTable).where(eq(likedSongsTable.uri, uri)).limit(1);
	return Response.json({ liked: Boolean(row) }, { headers: { 'Cache-Control': 'no-store' } });
};

export const DELETE: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (typeof body?.uri !== 'string' || !body.uri) return Response.json({ error: 'uri is required' }, { status: 400 });
	await db.delete(likedSongsTable).where(eq(likedSongsTable.uri, body.uri));
	return Response.json({ success: true });
};

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
