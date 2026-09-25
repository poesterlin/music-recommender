import { readdir, realpath, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const SUPPORTED_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.m4a', '.ogg']);
const DEFAULT_REFRESH_SECONDS = 300;

type FileIndex = Map<string, string[]>;
type IndexCache = {
	configuredRoot: string;
	root: string;
	files: FileIndex;
	refreshedAt: number;
};

let cached: IndexCache | null = null;
let refreshPromise: Promise<IndexCache> | null = null;

export class AudioFileNotFoundError extends Error {
	constructor(uri: string) {
		super(`no local audio file matched ${uri}`);
		this.name = 'AudioFileNotFoundError';
	}
}

function configuredRoot(): string {
	const value = (process.env.MUSIC_LIBRARY_PATH ?? process.env.AUDIO_DIR ?? '/music').trim();
	if (!value) throw new Error('MUSIC_LIBRARY_PATH is not configured');
	return value;
}

function refreshSeconds(): number {
	const value = Number(process.env.AUDIO_INDEX_REFRESH_SECONDS ?? DEFAULT_REFRESH_SECONDS);
	return Number.isFinite(value) && value >= 0 ? value : DEFAULT_REFRESH_SECONDS;
}

function normalized(value: unknown): string {
	if (typeof value !== 'string') return '';
	// Metadata and local filenames often differ only by diacritics (for example,
	// "Obtener un sí" versus "Obtener un si").
	return value
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.normalize('NFKC')
		.replace(/\u2026/g, '...')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
		.replace(/\s+/g, ' ')
		.toLowerCase()
		// NFKD does not decompose these letters, but local filenames often do.
		.replace(/ø/g, 'o')
		.replace(/æ/g, 'ae')
		.replace(/œ/g, 'oe')
		.replace(/ð/g, 'd')
		.replace(/þ/g, 'th')
		.replace(/ß/g, 'ss')
		.replace(/ł/g, 'l')
		.replace(/ı/g, 'i');
}

function addFile(index: FileIndex, path: string): void {
	const filename = path.split(sep).at(-1) ?? '';
	const dot = filename.lastIndexOf('.');
	if (dot < 0) return;
	const stem = filename.slice(0, dot);
	const extension = filename.slice(dot).toLowerCase();
	if (!SUPPORTED_EXTENSIONS.has(extension)) return;

	const name = normalized(stem);
	if (name) {
		const values = index.get(name) ?? [];
		values.push(path);
		index.set(name, values);
	}

	const numbered = stem.match(/^(\d{2})\s*-\s*(.+)$/i);
	if (numbered) {
		const alternate = normalized(numbered[2]);
		if (alternate) {
			const values = index.get(alternate) ?? [];
			values.push(path);
			index.set(alternate, values);
		}
	}
}

async function walk(root: string, directory: string, index: FileIndex): Promise<void> {
	const entries = await readdir(directory, { withFileTypes: true });
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			await walk(root, path, index);
		} else if (entry.isFile()) {
			addFile(index, path);
		}
	}
}

async function buildIndex(configuredRoot: string): Promise<IndexCache> {
	const resolvedRoot = await realpath(configuredRoot);
	const info = await stat(resolvedRoot);
	if (!info.isDirectory()) throw new Error(`music library is not a directory: ${resolvedRoot}`);

	const files: FileIndex = new Map();
	await walk(resolvedRoot, resolvedRoot, files);
	return {
		configuredRoot,
		root: resolvedRoot,
		files,
		refreshedAt: Date.now()
	};
}

async function getIndex(): Promise<IndexCache> {
	const root = configuredRoot();
	const now = Date.now();
	if (
		cached &&
		cached.configuredRoot === root &&
		now - cached.refreshedAt < refreshSeconds() * 1_000
	) {
		return cached;
	}
	if (refreshPromise) return refreshPromise;

	refreshPromise = buildIndex(root)
		.then((result) => {
			cached = result;
			return result;
		})
		.finally(() => {
			refreshPromise = null;
		});
	return refreshPromise;
}

function ensureInsideRoot(root: string, path: string): string {
	const pathRelative = relative(root, path);
	if (pathRelative.startsWith(`..${sep}`) || pathRelative === '..' || pathRelative.includes(`..${sep}`)) {
		throw new Error('resolved audio path escaped the configured music root');
	}
	return path;
}

export type AudioTrack = {
	uri: string;
	name: string;
	artist?: string[] | string;
	album?: string;
};

export async function findLocalAudioFile(track: AudioTrack): Promise<string> {
	const index = await getIndex();
	const name = normalized(track.name);
	if (!name) throw new AudioFileNotFoundError(track.uri);

	const candidates = index.files.get(name) ?? [];
	if (candidates.length === 0) throw new AudioFileNotFoundError(track.uri);

	let selected = candidates[0];
	if (candidates.length > 1) {
		const album = normalized(track.album);
		const artist = normalized(
			Array.isArray(track.artist) ? track.artist.join(' ') : track.artist
		);
		const matching = candidates.find((candidate) => {
			const key = normalized(candidate);
			return (!artist || key.includes(artist)) && (!album || key.includes(album));
		});
		if (matching) {
			selected = matching;
		} else if (album) {
			selected =
				candidates.find((candidate) => normalized(candidate).includes(album)) ?? selected;
		}
	}
	return ensureInsideRoot(index.root, selected);
}

export function configuredAudioRoot(): string {
	return configuredRoot();
}
