import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { workerAuthError } from '$lib/server/worker-auth';
import type { RequestHandler } from './$types';

const MODEL = 'openl3-512';
const DIMENSIONS = 512;
const MAX_BATCH = 16;
const MAX_BODY_BYTES = 512 * 1024;

type UploadItem = {
	uri: string;
	name: string;
	artist: string[];
	album: string;
	updatedAt?: string;
	model: string;
	embedding: number[];
};

type TrackRow = {
	name: string;
	artist: string[];
	album: string;
	updated_at: string | Date;
	embedded: boolean;
	skipped: boolean;
};

function errorResponse(message: string, status: number): Response {
	return Response.json({ error: message }, { status });
}

function isValidItem(value: unknown): value is UploadItem {
	if (!value || typeof value !== 'object') return false;
	const item = value as Partial<UploadItem>;
	return (
		typeof item.uri === 'string' &&
		item.uri.length > 0 &&
		item.uri.length <= 2048 &&
		typeof item.name === 'string' &&
		Array.isArray(item.artist) &&
		item.artist.every((artist) => typeof artist === 'string') &&
		typeof item.album === 'string' &&
		(item.updatedAt === undefined || typeof item.updatedAt === 'string') &&
		item.model === MODEL &&
		Array.isArray(item.embedding) &&
		item.embedding.length === DIMENSIONS &&
		item.embedding.every((value) => typeof value === 'number' && Number.isFinite(value))
	);
}

function vectorLiteral(embedding: number[]): string {
	return `[${embedding.map((value) => value.toFixed(8)).join(',')}]`;
}

function sameMetadata(row: TrackRow, item: UploadItem): boolean {
	if (row.name !== item.name || row.album !== item.album || JSON.stringify(row.artist) !== JSON.stringify(item.artist)) {
		return false;
	}
	if (!item.updatedAt) return true;
	const rowUpdated = row.updated_at instanceof Date ? row.updated_at.getTime() : Date.parse(row.updated_at);
	const itemUpdated = Date.parse(item.updatedAt);
	return Number.isFinite(rowUpdated) && Math.abs(rowUpdated - itemUpdated) < 1_000;
}

export const POST: RequestHandler = async ({ request }) => {
	const authError = workerAuthError(request);
	if (authError) return authError;

	const contentLength = Number(request.headers.get('content-length') ?? 0);
	if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
		return errorResponse('request body is too large', 413);
	}

	let body: { embeddings?: unknown };
	try {
		const raw = await request.text();
		if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
			return errorResponse('request body is too large', 413);
		}
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return errorResponse('request body must be a JSON object', 400);
		}
		body = parsed as { embeddings?: unknown };
	} catch {
		return errorResponse('request body must be valid JSON', 400);
	}

	if (!Array.isArray(body.embeddings) || body.embeddings.length < 1 || body.embeddings.length > MAX_BATCH) {
		return errorResponse(`embeddings must contain 1-${MAX_BATCH} items`, 400);
	}
	if (!body.embeddings.every(isValidItem)) {
		return errorResponse(`each embedding must be a finite ${DIMENSIONS}-value ${MODEL} vector with track metadata`, 400);
	}

	const items = body.embeddings;
	const accepted: Array<{ uri: string; status: 'written' | 'already_embedded' }> = [];
	const rejected: Array<{ uri: string; reason: string }> = [];

	try {
		await db.transaction(async (tx) => {
			for (const item of items) {
				const rows = (await tx.execute(sql`
					SELECT
						name,
						artist,
						album,
						updated_at,
						embedding IS NOT NULL AS embedded,
						COALESCE(skip, FALSE) AS skipped
					FROM track
					WHERE uri = ${item.uri}
					FOR UPDATE
				`)) as TrackRow[];
				const row = rows[0];
				if (!row) {
					rejected.push({ uri: item.uri, reason: 'track not found' });
					continue;
				}
				if (row.skipped) {
					rejected.push({ uri: item.uri, reason: 'track is skipped' });
					continue;
				}
				if (!sameMetadata(row, item)) {
					rejected.push({ uri: item.uri, reason: 'track metadata changed' });
					continue;
				}
				if (row.embedded) {
					accepted.push({ uri: item.uri, status: 'already_embedded' });
					continue;
				}

				await tx.execute(sql`
					UPDATE track
					SET embedding = ${vectorLiteral(item.embedding)}::vector,
						updated_at = NOW()
					WHERE uri = ${item.uri}
					  AND embedding IS NULL
					  AND (skip IS NULL OR skip = FALSE)
				`);
				accepted.push({ uri: item.uri, status: 'written' });
			}
		});
	} catch (error) {
		console.error('Worker embedding upload failed:', error);
		return errorResponse('could not write embeddings', 500);
	}

	return Response.json(
		{
			model: MODEL,
			dimensions: DIMENSIONS,
			accepted,
			rejected,
			ok: rejected.length === 0
		},
		{ status: rejected.length === 0 ? 200 : 409 }
	);
};
