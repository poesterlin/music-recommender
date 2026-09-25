import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { workerAuthError } from '$lib/server/worker-auth';
import type { RequestHandler } from './$types';

const MAX_LIMIT = 32;
const DEFAULT_LIMIT = 8;

type TrackRow = {
	uri: string;
	name: string;
	artist: string[];
	album: string;
	updated_at: string | Date;
};

function boundedLimit(value: string | null): number {
	const parsed = Number(value ?? DEFAULT_LIMIT);
	if (!Number.isSafeInteger(parsed)) return DEFAULT_LIMIT;
	return Math.min(Math.max(parsed, 1), MAX_LIMIT);
}

export const GET: RequestHandler = async ({ request, url }) => {
	const authError = workerAuthError(request);
	if (authError) return authError;

	const after = url.searchParams.get('after');
	if (after && after.length > 2048) {
		return Response.json({ error: 'after cursor is too long' }, { status: 400 });
	}
	const limit = boundedLimit(url.searchParams.get('limit'));

	try {
		const rows = (await db.execute(
			after
				? sql`
					SELECT uri, name, artist, album, updated_at
					FROM track
					WHERE embedding IS NULL
					  AND (skip IS NULL OR skip = FALSE)
					  AND (uri COLLATE "C") > (${after}::text COLLATE "C")
					ORDER BY uri COLLATE "C"
					LIMIT ${limit}
				`
				: sql`
					SELECT uri, name, album, updated_at, artist
					FROM track
					WHERE embedding IS NULL
					  AND (skip IS NULL OR skip = FALSE)
					ORDER BY uri COLLATE "C"
					LIMIT ${limit}
				`
		)) as TrackRow[];

		const tracks = rows.map((row) => ({
			uri: row.uri,
			name: row.name,
			artist: Array.isArray(row.artist) ? row.artist : [],
			album: row.album,
			updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
		}));
		return Response.json(
			{
				model: 'openl3-512',
				dimensions: 512,
				tracks,
				nextCursor: tracks.at(-1)?.uri ?? null,
				hasMore: tracks.length === limit
			},
			{ headers: { 'Cache-Control': 'no-store' } }
		);
	} catch (error) {
		console.error('Worker track listing failed:', error);
		return Response.json({ error: 'could not list worker tracks' }, { status: 500 });
	}
};
