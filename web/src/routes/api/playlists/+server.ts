import { savePlaylist } from '$lib/server/playlists';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	let body: { name?: unknown; uris?: unknown };
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: 'Invalid JSON' }, { status: 400 });
	}
	if (!body || typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 200) {
		return Response.json({ error: 'Enter a playlist name of 1–200 characters' }, { status: 400 });
	}
	if (!Array.isArray(body.uris) || body.uris.length < 1 || body.uris.length > 100 ||
		!body.uris.every((uri): uri is string => typeof uri === 'string' && uri.length > 0 && uri.length <= 2048)) {
		return Response.json({ error: 'Provide 1–100 track URIs' }, { status: 400 });
	}
	try {
		const playlist = await savePlaylist(body.name.trim(), body.uris);
		return Response.json({ success: true, playlist });
	} catch (error) {
		console.error('[playlists] save failed:', error);
		return Response.json({ error: String(error) }, { status: 502 });
	}
};
