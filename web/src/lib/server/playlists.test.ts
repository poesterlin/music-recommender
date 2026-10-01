import { expect, test } from 'bun:test';
import { createPlaylistWithTracks } from './playlists';

test('creates a playlist and adds the displayed track order to its library ID', async () => {
	const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
	const uris = ['library://track/7', 'library://track/2'];
	const result = await createPlaylistWithTracks(async (command, args) => {
		calls.push({ command, args });
		return command.endsWith('/create_playlist') ? { item_id: '42', name: 'Evening' } : null;
	}, 'Evening', uris);
	expect(calls).toEqual([
		{ command: 'music/playlists/create_playlist', args: { name: 'Evening' } },
		{ command: 'music/playlists/add_playlist_tracks', args: { db_playlist_id: '42', uris } }
	]);
	expect(result).toEqual({ id: '42', name: 'Evening', trackCount: 2 });
});

test('reports partial creation rather than claiming the tracks were saved', async () => {
	await expect(createPlaylistWithTracks(async (command) => {
		if (command.endsWith('/create_playlist')) return { item_id: '42' };
		throw new Error('provider unavailable');
	}, 'Evening', ['library://track/7'])).rejects.toThrow('was created, but adding tracks failed');
});

test('does not submit tracks when Music Assistant returns no playlist ID', async () => {
	let calls = 0;
	await expect(createPlaylistWithTracks(async () => { calls++; return {}; },
		'Evening', ['library://track/7'])).rejects.toThrow('did not return a playlist ID');
	expect(calls).toBe(1);
});
