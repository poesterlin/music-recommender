import {
	getPlayerState,
	playUris,
	playerControl,
	seekTo,
	setShuffle,
	setVolume,
	type PlayerAction
} from '$lib/server/player';
import type { RequestHandler } from './$types';

const ACTIONS: PlayerAction[] = ['play', 'pause', 'play_pause', 'stop', 'next', 'previous'];

export const GET: RequestHandler = async () => {
	try {
		const state = await getPlayerState();
		if (!state) return Response.json({ success: false, error: 'No player found' }, { status: 404 });
		return Response.json({ success: true, ...state });
	} catch (error) {
		console.error('player state failed:', error);
		return Response.json({ success: false, error: String(error) }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = (await request.json().catch(() => ({}))) as {
			action?: string;
			volume?: number;
			seek?: number;
			shuffle?: boolean;
			uris?: string[];
		};
		if (Array.isArray(body.uris) && body.uris.length > 0) {
			await playUris(body.uris.map(String));
		} else if (body.volume !== undefined) {
			await setVolume(Number(body.volume));
		} else if (body.seek !== undefined) {
			await seekTo(Number(body.seek));
		} else if (body.shuffle !== undefined) {
			await setShuffle(Boolean(body.shuffle));
		} else if (body.action && ACTIONS.includes(body.action as PlayerAction)) {
			await playerControl(body.action as PlayerAction);
			// give MA a beat to update state before the client re-fetches
			await new Promise((r) => setTimeout(r, 600));
		} else {
			return Response.json(
				{ success: false, error: `pass uris[], volume, seek, shuffle, or action (${ACTIONS.join(', ')})` },
				{ status: 400 }
			);
		}
		const state = await getPlayerState().catch(() => null);
		return Response.json({ success: true, ...state });
	} catch (error) {
		console.error('player control failed:', error);
		return Response.json({ success: false, error: String(error) }, { status: 500 });
	}
};
