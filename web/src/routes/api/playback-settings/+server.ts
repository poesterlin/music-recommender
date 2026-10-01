import { getPlaybackPlayer, setPlaybackPlayer } from '$lib/server/playback-settings';
import {
	InvalidPlaybackPlayerError,
	listPlaybackPlayers,
	validatePlaybackPlayer
} from '$lib/server/player';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () =>
	Response.json(
		{
			playerId: await getPlaybackPlayer(),
			players: await listPlaybackPlayers()
		},
		{ headers: { 'Cache-Control': 'no-store' } }
	);

export const PUT: RequestHandler = async ({ request, locals }) => {
	if (!locals.user || locals.method !== 'session')
		return Response.json({ error: 'session required' }, { status: 403 });
	const body = await request.json().catch(() => null);
	if (!body || (body.playerId !== null && typeof body.playerId !== 'string')) {
		return Response.json(
			{ error: 'Choose a playback player or automatic selection.' },
			{ status: 400 }
		);
	}
	try {
		const playerId = body.playerId === null ? null : await validatePlaybackPlayer(body.playerId);
		await setPlaybackPlayer(playerId);
		return Response.json({ playerId });
	} catch (error) {
		if (error instanceof InvalidPlaybackPlayerError)
			return Response.json({ error: error.message }, { status: 400 });
		return Response.json(
			{ error: 'Could not save the playback device. Check the Music Assistant connection.' },
			{ status: 503 }
		);
	}
};
