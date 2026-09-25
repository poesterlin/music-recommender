import { readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

const SUPPORTED_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.m4a', '.ogg']);
const DEFAULT_REFRESH_SECONDS = 300;
const FUZZY_MIN_TITLE_SCORE = 0.82;
const FUZZY_MIN_PREFIX_SCORE = 0.7;
const FUZZY_MIN_TOTAL_SCORE = 0.78;
const FUZZY_MIN_PREFIX_TOTAL_SCORE = 0.74;
const FUZZY_MIN_MARGIN = 0.04;
const FUZZY_MIN_TITLE_LENGTH = 12;

type FileIndex = Map<string, string[]>;
type FileEntry = {
	path: string;
	title: string;
	titleTokens: string[];
	titleTokenSet: Set<string>;
	titleBigrams: Set<string>;
	directoryKey: string;
	directorySegments: string[];
	directoryTokenSet: Set<string>;
};
type IndexCache = {
	configuredRoot: string;
	root: string;
	files: FileIndex;
	compactFiles: FileIndex;
	entries: FileEntry[];
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
	return (
		value
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
			.replace(/ı/g, 'i')
	);
}

function tokenize(value: string): string[] {
	return value ? value.split(' ') : [];
}

function compactKey(value: string): string {
	return value.replace(/ /g, '');
}

function bigrams(value: string): Set<string> {
	const compact = value.replace(/\s+/g, ' ').trim();
	const result = new Set<string>();
	if (!compact) return result;
	if (compact.length < 2) {
		result.add(compact);
		return result;
	}
	for (let index = 0; index < compact.length - 1; index += 1) {
		result.add(compact.slice(index, index + 2));
	}
	return result;
}

function diceSimilarity(left: Set<string>, right: Set<string>): number {
	if (left.size === 0 || right.size === 0) return left.size === right.size ? 1 : 0;
	let intersection = 0;
	for (const value of left) {
		if (right.has(value)) intersection += 1;
	}
	return (2 * intersection) / (left.size + right.size);
}

function titleSimilarity(
	queryTokens: string[],
	queryTokenSet: Set<string>,
	queryBigrams: Set<string>,
	entry: FileEntry
): number {
	const candidateTokens = entry.titleTokens;
	let intersection = 0;
	for (const token of entry.titleTokenSet) {
		if (queryTokenSet.has(token)) intersection += 1;
	}

	const tokenF1 =
		queryTokens.length + candidateTokens.length === 0
			? 0
			: (2 * intersection) / (queryTokens.length + candidateTokens.length);
	const containment =
		Math.min(queryTokens.length, candidateTokens.length) === 0
			? 0
			: intersection / Math.min(queryTokens.length, candidateTokens.length);
	const lengthRatio =
		Math.max(queryTokens.length, candidateTokens.length) === 0
			? 0
			: Math.min(queryTokens.length, candidateTokens.length) /
				Math.max(queryTokens.length, candidateTokens.length);
	let prefix = 0;
	while (
		prefix < queryTokens.length &&
		prefix < candidateTokens.length &&
		queryTokens[prefix] === candidateTokens[prefix]
	) {
		prefix += 1;
	}
	const prefixRatio = prefix / Math.max(queryTokens.length, candidateTokens.length, 1);
	const bigramScore = diceSimilarity(queryBigrams, entry.titleBigrams);

	return Math.max(
		tokenF1,
		0.65 * containment + 0.35 * lengthRatio,
		0.6 * prefixRatio + 0.4 * containment,
		bigramScore
	);
}

function isTruncatedPrefix(query: string, entry: FileEntry): boolean {
	return (
		query.length > entry.title.length &&
		query.startsWith(entry.title) &&
		entry.title.length >= 24 &&
		entry.titleTokens.length >= 3 &&
		entry.title.length / query.length >= 0.6
	);
}

function sharedTokenCount(queryTokenSet: Set<string>, entry: FileEntry): number {
	let count = 0;
	for (const token of entry.titleTokenSet) {
		if (queryTokenSet.has(token)) count += 1;
	}
	return count;
}

function containsSequence(values: string[], sequence: string[]): boolean {
	if (sequence.length === 0 || sequence.length > values.length) return false;
	for (let start = 0; start <= values.length - sequence.length; start += 1) {
		if (sequence.every((token, offset) => values[start + offset] === token)) return true;
	}
	return false;
}

function phraseScore(
	phrase: string,
	directoryKey: string,
	directorySegments: string[],
	directoryTokenSet: Set<string>
): number {
	if (!phrase) return 0.5;
	const tokens = tokenize(phrase);
	if (tokens.length === 0) return 0;
	if (containsSequence(directorySegments, tokens)) return 1;
	if (directoryKey.includes(phrase)) return 0.85;
	let matches = 0;
	for (const token of tokens) {
		if (directoryTokenSet.has(token)) matches += 1;
	}
	return matches / tokens.length;
}

function artistKeys(track: AudioTrack): string[] {
	const values = Array.isArray(track.artist) ? track.artist : [track.artist];
	return values.map((value) => normalized(value)).filter((value) => value.length > 0);
}

function contextScore(
	directoryKey: string,
	directorySegments: string[],
	directoryTokenSet: Set<string>,
	artists: string[],
	album: string
): number | null {
	const artistMatches = artists.map((artist) =>
		phraseScore(artist, directoryKey, directorySegments, directoryTokenSet)
	);
	const artistMatch = artistMatches.length === 0 ? null : Math.max(...artistMatches);
	const albumMatch = album
		? phraseScore(album, directoryKey, directorySegments, directoryTokenSet)
		: null;
	const components = [artistMatch, albumMatch].filter((value): value is number => value !== null);
	return components.length === 0
		? null
		: components.reduce((total, value) => total + value, 0) / components.length;
}

function hasFuzzyOverlap(
	queryTokenSet: Set<string>,
	queryBigrams: Set<string>,
	entry: FileEntry
): boolean {
	for (const token of entry.titleTokenSet) {
		if (queryTokenSet.has(token)) return true;
	}
	for (const value of entry.titleBigrams) {
		if (queryBigrams.has(value)) return true;
	}
	return false;
}

function addFile(
	root: string,
	index: FileIndex,
	compactIndex: FileIndex,
	entries: FileEntry[],
	path: string
): void {
	const filename = path.split(sep).at(-1) ?? '';
	const dot = filename.lastIndexOf('.');
	if (dot < 0) return;
	const stem = filename.slice(0, dot);
	const extension = filename.slice(dot).toLowerCase();
	if (!SUPPORTED_EXTENSIONS.has(extension)) return;

	const name = normalized(stem);
	const numbered = stem.match(/^\d{1,3}\s*[-_.–—]\s*(.+)$/i);
	const alternate = numbered ? normalized(numbered[1]) : '';
	for (const key of new Set([name, alternate])) {
		if (!key) continue;
		const values = index.get(key) ?? [];
		values.push(path);
		index.set(key, values);
		const compact = compactKey(key);
		if (compact) {
			const compactValues = compactIndex.get(compact) ?? [];
			compactValues.push(path);
			compactIndex.set(compact, compactValues);
		}
	}

	const title = alternate || name;
	if (!title) return;
	const titleTokens = tokenize(title);
	const directoryKey = normalized(relative(root, dirname(path)));
	const directorySegments = tokenize(directoryKey);
	entries.push({
		path,
		title,
		titleTokens,
		titleTokenSet: new Set(titleTokens),
		titleBigrams: bigrams(title),
		directoryKey,
		directorySegments,
		directoryTokenSet: new Set(directorySegments)
	});
}

async function walk(
	root: string,
	directory: string,
	index: FileIndex,
	compactIndex: FileIndex,
	entries: FileEntry[]
): Promise<void> {
	const children = await readdir(directory, { withFileTypes: true });
	children.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of children) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			await walk(root, path, index, compactIndex, entries);
		} else if (entry.isFile()) {
			addFile(root, index, compactIndex, entries, path);
		}
	}
}

async function buildIndex(configuredRoot: string): Promise<IndexCache> {
	const resolvedRoot = await realpath(configuredRoot);
	const info = await stat(resolvedRoot);
	if (!info.isDirectory()) throw new Error(`music library is not a directory: ${resolvedRoot}`);

	const files: FileIndex = new Map();
	const compactFiles: FileIndex = new Map();
	const entries: FileEntry[] = [];
	await walk(resolvedRoot, resolvedRoot, files, compactFiles, entries);
	return {
		configuredRoot,
		root: resolvedRoot,
		files,
		compactFiles,
		entries,
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
	if (
		pathRelative.startsWith(`..${sep}`) ||
		pathRelative === '..' ||
		pathRelative.includes(`..${sep}`)
	) {
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

type ScoredCandidate = {
	entry: FileEntry;
	titleScore: number;
	context: number | null;
	total: number;
};

function pathPreference(path: string): number {
	const lower = path.toLowerCase();
	let penalty = 0;
	if (/\.\d+\.[^.]+$/.test(lower)) penalty += 2;
	if (/\breissue\b/.test(lower)) penalty += 1;
	if (/\bexpanded edition\b/.test(lower)) penalty += 0.5;
	return penalty;
}

function preferredPath(paths: string[]): string {
	return [...paths].sort(
		(left, right) =>
			pathPreference(left) - pathPreference(right) ||
			left.length - right.length ||
			left.localeCompare(right)
	)[0];
}

function selectIndexedCandidate(
	candidates: string[],
	track: AudioTrack,
	root: string
): string | null {
	if (candidates.length === 1) return candidates[0];
	const artists = artistKeys(track);
	const album = normalized(track.album);
	const ranked = candidates
		.map((path) => {
			const directoryKey = normalized(relative(root, dirname(path)));
			return {
				path,
				context: contextScore(
					directoryKey,
					tokenize(directoryKey),
					new Set(tokenize(directoryKey)),
					artists,
					album
				)
			};
		})
		.sort((left, right) => (right.context ?? -1) - (left.context ?? -1));
	const best = ranked[0];
	if (!best || best.context === null || best.context <= 0) return null;
	const contenders = ranked
		.filter((candidate) => candidate.context === best.context)
		.map((candidate) => candidate.path);
	return preferredPath(contenders);
}

function hasStrongContext(context: number | null, artists: string[], album: string): boolean {
	if (context === null) return true;
	if (artists.length > 0 && album) return context >= 0.75;
	if (artists.length > 0 || album) return context >= 0.5;
	return true;
}

function findFuzzyCandidate(index: IndexCache, track: AudioTrack, name: string): string | null {
	const queryTokens = tokenize(name);
	if (queryTokens.length === 0) return null;
	const queryTokenSet = new Set(queryTokens);
	const queryBigrams = bigrams(name);
	const artists = artistKeys(track);
	const album = normalized(track.album);
	const scored: ScoredCandidate[] = [];

	for (const entry of index.entries) {
		if (!hasFuzzyOverlap(queryTokenSet, queryBigrams, entry)) continue;
		const titleScore = titleSimilarity(queryTokens, queryTokenSet, queryBigrams, entry);
		const prefixMatch = isTruncatedPrefix(name, entry);
		if (prefixMatch) {
			if (titleScore < FUZZY_MIN_PREFIX_SCORE) continue;
		} else {
			if (
				name.length < FUZZY_MIN_TITLE_LENGTH ||
				sharedTokenCount(queryTokenSet, entry) < 2 ||
				titleScore < FUZZY_MIN_TITLE_SCORE
			) {
				continue;
			}
		}
		const context = contextScore(
			entry.directoryKey,
			entry.directorySegments,
			entry.directoryTokenSet,
			artists,
			album
		);
		if (!hasStrongContext(context, artists, album)) continue;
		const total = context === null ? titleScore : titleScore * 0.8 + context * 0.2;
		const minimum = prefixMatch ? FUZZY_MIN_PREFIX_TOTAL_SCORE : FUZZY_MIN_TOTAL_SCORE;
		if (total < minimum) continue;
		scored.push({ entry, titleScore, context, total });
	}

	scored.sort(
		(left, right) =>
			right.total - left.total ||
			right.titleScore - left.titleScore ||
			left.entry.path.localeCompare(right.entry.path)
	);
	const best = scored[0];
	if (!best) return null;
	const second = scored[1];
	if (second && best.total - second.total < FUZZY_MIN_MARGIN) return null;
	return best.entry.path;
}

export async function findLocalAudioFile(track: AudioTrack): Promise<string> {
	const index = await getIndex();
	const name = normalized(track.name);
	if (!name) throw new AudioFileNotFoundError(track.uri);

	const candidates = index.files.get(name) ?? [];
	if (candidates.length > 0) {
		const selected = selectIndexedCandidate(candidates, track, index.root);
		if (selected) return ensureInsideRoot(index.root, selected);
	}

	const compactCandidates = index.compactFiles.get(compactKey(name)) ?? [];
	if (compactCandidates.length > 0) {
		const selected = selectIndexedCandidate(compactCandidates, track, index.root);
		if (selected) return ensureInsideRoot(index.root, selected);
	}

	const fuzzy = findFuzzyCandidate(index, track, name);
	if (fuzzy) return ensureInsideRoot(index.root, fuzzy);
	throw new AudioFileNotFoundError(track.uri);
}

export function configuredAudioRoot(): string {
	return configuredRoot();
}
