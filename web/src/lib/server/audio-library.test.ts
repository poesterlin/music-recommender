import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findLocalAudioFile } from './audio-library';

const originalRoot = process.env.MUSIC_LIBRARY_PATH;
const originalRefresh = process.env.AUDIO_INDEX_REFRESH_SECONDS;
const temporaryRoots: string[] = [];

async function makeLibrary(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'music-recommender-audio-'));
	temporaryRoots.push(root);
	process.env.MUSIC_LIBRARY_PATH = root;
	process.env.AUDIO_INDEX_REFRESH_SECONDS = '0';
	for (const [relativePath, contents] of Object.entries(files)) {
		const path = join(root, relativePath);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, contents);
	}
	return root;
}

afterEach(async () => {
	if (originalRoot === undefined) delete process.env.MUSIC_LIBRARY_PATH;
	else process.env.MUSIC_LIBRARY_PATH = originalRoot;
	if (originalRefresh === undefined) delete process.env.AUDIO_INDEX_REFRESH_SECONDS;
	else process.env.AUDIO_INDEX_REFRESH_SECONDS = originalRefresh;
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
});

describe('findLocalAudioFile', () => {
	test('matches special characters and safe track-number variants', async () => {
		const root = await makeLibrary({
			'Hollywood Undead/New Empire, Vol. 2/11 - Idol (feat. Ghostkid).mp3': 'audio',
			'Artist/Album/1. Song.mp3': 'audio',
			'Artist/Album/002 – Another Song.mp3': 'audio'
		});

		expect(
			await findLocalAudioFile({
				uri: 'library://track/1',
				name: 'Idol (feat. Ghøstkid)',
				artist: ['Hollywood Undead'],
				album: 'New Empire, Vol. 2'
			})
		).toBe(join(root, 'Hollywood Undead/New Empire, Vol. 2/11 - Idol (feat. Ghostkid).mp3'));
		expect(
			await findLocalAudioFile({
				uri: 'library://track/2',
				name: 'Song',
				artist: ['Artist'],
				album: 'Album'
			})
		).toBe(join(root, 'Artist/Album/1. Song.mp3'));
		expect(
			await findLocalAudioFile({
				uri: 'library://track/3',
				name: 'Another Song',
				artist: ['Artist'],
				album: 'Album'
			})
		).toBe(join(root, 'Artist/Album/002 – Another Song.mp3'));
	});

	test('matches punctuation-only differences through the compact index', async () => {
		const root = await makeLibrary({
			'Artist/Album/01 - A.C.D.C. - T.N.T..mp3': 'audio'
		});

		expect(
			await findLocalAudioFile({
				uri: 'library://track/1',
				name: 'ACDC TNT',
				artist: ['Artist'],
				album: 'Album'
			})
		).toBe(join(root, 'Artist/Album/01 - A.C.D.C. - T.N.T..mp3'));
	});

	test('matches a long filename that was truncated by the library', async () => {
		const title =
			'The Black Hawk War, or, How to Demolish an Entire Civilization and Still Feel Good About Yourself in the Morning';
		const root = await makeLibrary({
			[`Sufjan Stevens/Illinois/02 - ${title.slice(0, -5)}.mp3`]: 'audio'
		});

		expect(
			await findLocalAudioFile({
				uri: 'library://track/1',
				name: `${title} and Continue`,
				artist: ['Sufjan Stevens'],
				album: 'Illinois'
			})
		).toBe(join(root, `Sufjan Stevens/Illinois/02 - ${title.slice(0, -5)}.mp3`));
	});

	test('allows a close typo but rejects short ambiguous titles', async () => {
		const root = await makeLibrary({
			'Artist/Album/01 - The Quick Brown Fox.mp3': 'audio',
			'Artist/Album/02 - Cat.mp3': 'audio'
		});

		expect(
			await findLocalAudioFile({
				uri: 'library://track/1',
				name: 'The Quick Brown Foxx',
				artist: ['Artist'],
				album: 'Album'
			})
		).toBe(join(root, 'Artist/Album/01 - The Quick Brown Fox.mp3'));
		await expect(
			findLocalAudioFile({
				uri: 'library://track/2',
				name: 'Cot',
				artist: ['Artist'],
				album: 'Album'
			})
		).rejects.toThrow('no local audio file matched');
	});

	test('uses artist and album context to disambiguate duplicate titles', async () => {
		const root = await makeLibrary({
			'Artist/First Album/01 - Shared Title.mp3': 'audio',
			'Artist/Second Album/01 - Shared Title.mp3': 'audio'
		});

		expect(
			await findLocalAudioFile({
				uri: 'library://track/1',
				name: 'Shared Title',
				artist: ['Artist'],
				album: 'Second Album'
			})
		).toBe(join(root, 'Artist/Second Album/01 - Shared Title.mp3'));
	});
});
