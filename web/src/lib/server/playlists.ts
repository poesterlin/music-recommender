import { withMa } from './ma-client';

export async function savePlaylist(name: string, uris: string[]) {
	return withMa((call) => createPlaylistWithTracks(call, name, uris));
}

export async function createPlaylistWithTracks(
	call: (command: string, args?: Record<string, unknown>) => Promise<any>,
	name: string,
	uris: string[]
) {
	const playlist = await call('music/playlists/create_playlist', { name });
	const id = playlist?.item_id;
	if (id === undefined || id === null) {
		throw new Error('Music Assistant did not return a playlist ID');
	}
	try {
		await call('music/playlists/add_playlist_tracks', { db_playlist_id: id, uris });
	} catch (error) {
		throw new Error(`Playlist “${name}” was created, but adding tracks failed. Check it in Music Assistant before retrying. ${String(error)}`);
	}
	return { id: String(id), name: playlist.name ?? name, trackCount: uris.length };
}
