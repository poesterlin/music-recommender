import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { findLocalAudioFile, AudioFileNotFoundError } from '$lib/server/audio-library';
import { workerAuthError } from '$lib/server/worker-auth';
import type { RequestHandler } from './$types';

const DEFAULT_SECONDS = 60;
const MAX_SECONDS = 120;
const FFMPEG_PATH = process.env.FFMPEG_PATH ?? 'ffmpeg';

type TrackRow = {
	name: string;
	artist: string[];
	album: string;
};

function secondsFromRequest(value: string | null): number {
	const parsed = Number(value ?? DEFAULT_SECONDS);
	if (!Number.isFinite(parsed)) return DEFAULT_SECONDS;
	return Math.min(Math.max(parsed, 1), MAX_SECONDS);
}

function streamError(message: string, status: number): Response {
	return Response.json({ error: message }, { status });
}

export const GET: RequestHandler = async ({ request, url }) => {
	const authError = workerAuthError(request);
	if (authError) return authError;

	const uri = url.searchParams.get('uri');
	if (!uri || uri.length > 2048) return streamError('uri is required', 400);
	const seconds = secondsFromRequest(url.searchParams.get('seconds'));

	try {
		const rows = (await db.execute(sql`
			SELECT name, artist, album
			FROM track
			WHERE uri = ${uri} AND (skip IS NULL OR skip = FALSE)
		`)) as TrackRow[];
		const track = rows[0];
		if (!track) return streamError('track not found', 404);

		const path = await findLocalAudioFile({
			uri,
			name: track.name,
			artist: Array.isArray(track.artist) ? track.artist : [],
			album: track.album
		});
		const child = spawn(
			FFMPEG_PATH,
			[
				'-hide_banner',
				'-loglevel',
				'error',
				'-i',
				path,
				'-t',
				String(seconds),
				'-vn',
				'-ac',
				'1',
				'-ar',
				'48000',
				'-c:a',
				'libmp3lame',
				'-b:a',
				'128k',
				'-f',
				'mp3',
				'pipe:1'
			],
			{ stdio: ['ignore', 'pipe', 'pipe'] }
		);
		if (!child.stdout) return streamError('audio encoder did not start', 503);

		let spawnError: Error | null = null;
		await new Promise<void>((resolve, reject) => {
			child.once('spawn', resolve);
			child.once('error', (error) => {
				spawnError = error;
				reject(error);
			});
		});
		if (spawnError) return streamError('audio encoder is unavailable', 503);

		const abort = () => child.kill('SIGTERM');
		request.signal.addEventListener('abort', abort, { once: true });
		child.once('close', () => request.signal.removeEventListener('abort', abort));
		child.stderr?.resume();
		child.once('error', (error) => {
			console.error('Worker audio encoder failed:', error.message);
		});
		child.once('close', (code) => {
			if (code && code !== 0) console.error(`Worker audio encoder exited with code ${code}`);
		});

		return new Response(Readable.toWeb(child.stdout) as unknown as ReadableStream, {
			headers: {
				'Content-Type': 'audio/mpeg',
				'Cache-Control': 'no-store',
				'X-Content-Type-Options': 'nosniff'
			}
		});
	} catch (error) {
		if (error instanceof AudioFileNotFoundError) return streamError('audio source not found', 404);
		if (error instanceof Error && /ENOENT|audio encoder|ffmpeg/i.test(error.message)) {
			return streamError('audio encoder is unavailable', 503);
		}
		console.error('Worker audio request failed:', error);
		return streamError('could not create audio snippet', 500);
	}
};
