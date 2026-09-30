import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { recordWorkerProgress } from '$lib/server/job-log';
import { workerAuthError } from '$lib/server/worker-auth';
import { finalizeEmbeddingSpace } from '$lib/server/finalize-embedding-space';
import type { RequestHandler } from './$types';

const MODEL = 'openl3-512';
const DIMENSIONS = 512;
const MAX_BATCH = 16;
const MAX_BODY_BYTES = 512 * 1024;
class RecipeChangedError extends Error {}

/**
 * The recipe that produced a batch. OpenL3 is frame-based, so the hop changes
 * what a vector averages over and not just how long it takes; a vector centred
 * against the wrong corpus mean is silently worse rather than visibly broken,
 * so the upload must be attributable to a registered space.
 */
type Recipe = {
	model: string;
	hopSeconds: number;
	maxSampleSeconds: number;
	frontend: string;
};

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

function isValidRecipe(value: unknown): value is Recipe {
	if (!value || typeof value !== 'object') return false;
	const recipe = value as Partial<Recipe>;
	return (
		typeof recipe.model === 'string' &&
		recipe.model === MODEL &&
		typeof recipe.frontend === 'string' &&
		recipe.frontend.length > 0 &&
		recipe.frontend.length <= 64 &&
		typeof recipe.hopSeconds === 'number' &&
		Number.isFinite(recipe.hopSeconds) &&
		recipe.hopSeconds > 0 &&
		typeof recipe.maxSampleSeconds === 'number' &&
		Number.isFinite(recipe.maxSampleSeconds) &&
		recipe.maxSampleSeconds > 0
	);
}

/**
 * Find the space this recipe was registered as.
 *
 * Deliberately an exact match with no fallback. `embedding_space_for_settings`
 * falls back to the newest space, which is precisely the silent mix this is here
 * to prevent: an unregistered hop would land in some other space and read as
 * fine. Returning null lets the caller reject instead.
 */
async function resolveSpaceVersion(recipe: Recipe): Promise<number | null> {
	const rows = (await db.execute(sql`
		SELECT "version"
		FROM "embedding_space"
		WHERE "model" = ${recipe.model}
			AND "hop_seconds" IS NOT DISTINCT FROM ${recipe.hopSeconds}
			AND "max_sample_seconds" IS NOT DISTINCT FROM ${recipe.maxSampleSeconds}
			AND COALESCE("frontend", 'kapre') = ${recipe.frontend}
		ORDER BY "version" DESC
		LIMIT 1
	`)) as unknown as Array<{ version: number }>;
	const found = rows[0]?.version;
	return typeof found === 'number' ? found : null;
}

function vectorLiteral(embedding: number[]): string {
	return `[${embedding.map((value) => value.toFixed(8)).join(',')}]`;
}

function sameMetadata(row: TrackRow, item: UploadItem): boolean {
	if (
		row.name !== item.name ||
		row.album !== item.album ||
		JSON.stringify(row.artist) !== JSON.stringify(item.artist)
	) {
		return false;
	}
	if (!item.updatedAt) return true;
	const rowUpdated =
		row.updated_at instanceof Date ? row.updated_at.getTime() : Date.parse(row.updated_at);
	const itemUpdated = Date.parse(item.updatedAt);
	return Number.isFinite(rowUpdated) && Math.abs(rowUpdated - itemUpdated) < 1_000;
}

export const POST: RequestHandler = async ({ request }) => {
	const authError = await workerAuthError(request);
	if (authError) return authError;

	const contentLength = Number(request.headers.get('content-length') ?? 0);
	if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
		return errorResponse('request body is too large', 413);
	}

	let body: { recipe?: unknown; embeddings?: unknown };
	try {
		const raw = await request.text();
		if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
			return errorResponse('request body is too large', 413);
		}
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return errorResponse('request body must be a JSON object', 400);
		}
		body = parsed as { recipe?: unknown; embeddings?: unknown };
	} catch {
		return errorResponse('request body must be valid JSON', 400);
	}

	if (!isValidRecipe(body.recipe)) {
		// Required, not defaulted. Without it the write cannot be attributed to
		// a space, which is the one thing that makes a wrong-space mix
		// detectable.
		return errorResponse(
			`a recipe is required: {model: "${MODEL}", hopSeconds, maxSampleSeconds, frontend}`,
			400
		);
	}

	if (
		!Array.isArray(body.embeddings) ||
		body.embeddings.length < 1 ||
		body.embeddings.length > MAX_BATCH
	) {
		return errorResponse(`embeddings must contain 1-${MAX_BATCH} items`, 400);
	}
	if (!body.embeddings.every(isValidItem)) {
		return errorResponse(
			`each embedding must be a finite ${DIMENSIONS}-value ${MODEL} vector with track metadata`,
			400
		);
	}

	let spaceVersion: number | null;
	try {
		spaceVersion = await resolveSpaceVersion(body.recipe);
	} catch (error) {
		console.error('Embedding space lookup failed:', error);
		return errorResponse('could not resolve the embedding space', 500);
	}
	if (spaceVersion === null) {
		// Refusing is the whole point: accepting would centre these vectors
		// against a mean they were not produced for, and nothing downstream
		// would ever notice.
		return errorResponse(
			`no embedding space is registered for this recipe ` +
				`(hop ${body.recipe.hopSeconds}s, ${body.recipe.maxSampleSeconds}s, ` +
				`${body.recipe.frontend}). Register that recipe before uploading.`,
			409
		);
	}

	const items = body.embeddings;
	const recipe = body.recipe;
	const accepted: Array<{ uri: string; status: 'written' | 'already_embedded' }> = [];
	const rejected: Array<{ uri: string; reason: string }> = [];

	try {
		await db.transaction(async (tx) => {
			// Serialize recipe changes with uploads, then serialize provisional
			// centering before locking track rows (consistent lock order).
			const settings = await tx.execute(sql`
				SELECT id FROM embedding_settings
				WHERE id = 1 AND hop_seconds = ${recipe.hopSeconds}
					AND max_sample_seconds = ${recipe.maxSampleSeconds}
					AND frontend = ${recipe.frontend}
				FOR SHARE
			`);
			if (settings.length === 0) throw new RecipeChangedError('Worker recipe no longer matches the global settings; restart the worker.');
			await tx.execute(sql`SELECT version FROM embedding_space WHERE version = ${spaceVersion} FOR UPDATE`);
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
						embedding_space_version = ${spaceVersion},
						updated_at = NOW()
					WHERE uri = ${item.uri}
					  AND embedding IS NULL
					  AND (skip IS NULL OR skip = FALSE)
				`);
				accepted.push({ uri: item.uri, status: 'written' });
			}
			await finalizeEmbeddingSpace(tx, spaceVersion!);
		});
	} catch (error) {
		if (error instanceof RecipeChangedError) return errorResponse(error.message, 409);
		console.error('Worker embedding upload failed:', error);
		return errorResponse('could not write embeddings', 500);
	}

	// The worker never touches the database, so this upload is the only signal
	// that it is alive. Without it the external worker is indistinguishable
	// from a stopped one on the status page.
	void recordWorkerProgress({
		uploaded: accepted.length,
		written: accepted.filter((item) => item.status === 'written').length,
		failed: rejected.length
	});

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
