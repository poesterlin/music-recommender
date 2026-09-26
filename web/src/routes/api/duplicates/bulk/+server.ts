import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { MIXED_AUDIO_THRESHOLD, applyDuplicateSkip, findDuplicates } from '$lib/server/duplicates';
import type { RequestHandler } from './$types';

const BATCH_GROUPS = 4000;

/**
 * How many groups would a bulk prune act on, and how many copies that is.
 *
 * Returned before anything is written so the UI can show exact numbers in the
 * confirmation rather than "about right".
 */
async function bulkPlan(): Promise<{ groups: number; copies: number }> {
	const rows = await db.execute(sql`
		WITH grouped AS (
			SELECT lower(btrim(name)) AS gname, lower(artist[1]) AS gartist,
				lower(btrim(album)) AS galbum, uri, created_at,
				embedding, embedding_centered, skip,
				embedding IS NOT NULL AS embedded
			FROM track
		),
		numbered AS (
			SELECT g.*,
				row_number() OVER (PARTITION BY gname, gartist, galbum
					ORDER BY embedded DESC, created_at ASC NULLS LAST, uri ASC) AS rn,
				first_value(embedding_centered) OVER (PARTITION BY gname, gartist, galbum
					ORDER BY embedded DESC, created_at ASC NULLS LAST, uri ASC) AS keeper_vec
			FROM grouped g
		),
		dupe_groups AS (
			-- Named columns, not positional: position 1 is the concatenated key
			-- and position 2 is an aggregate, so GROUP BY 1,2,3 would be invalid.
			SELECT gname || '|' || gartist || '|' || galbum AS key, count(*)::int AS copies
			FROM grouped GROUP BY gname, gartist, galbum HAVING count(*) > 1
		),
		-- Only prune a group when every duplicate is the same recording as the
		-- keeper. Anything lower is a metadata collision and needs a human.
		unambiguous AS (
			SELECT d.key, d.copies
			FROM dupe_groups d
			JOIN numbered n
				ON (n.gname || '|' || n.gartist || '|' || n.galbum) = d.key
			WHERE n.rn > 1
				AND COALESCE(n.skip, FALSE) = FALSE
			GROUP BY d.key, d.copies
			HAVING bool_and(
				n.embedding_centered IS NULL OR n.keeper_vec IS NULL
				OR (1 - (n.embedding_centered <=> n.keeper_vec)) >= ${MIXED_AUDIO_THRESHOLD}
			)
		)
		SELECT count(*)::int AS groups, COALESCE(sum(copies - 1), 0)::int AS copies
		FROM unambiguous
	`);
	const row = (rows as unknown as Array<{ groups: number; copies: number }>)[0];
	return { groups: Number(row?.groups ?? 0), copies: Number(row?.copies ?? 0) };
}

/** Unambiguous group keys, paged, so a bulk prune runs in bounded batches. */
async function bulkKeys(limit: number): Promise<string[]> {
	const rows = await db.execute(sql`
		WITH grouped AS (
			SELECT lower(btrim(name)) AS gname, lower(artist[1]) AS gartist,
				lower(btrim(album)) AS galbum, uri, created_at,
				embedding, embedding_centered, skip,
				embedding IS NOT NULL AS embedded
			FROM track
		),
		numbered AS (
			SELECT g.*,
				row_number() OVER (PARTITION BY gname, gartist, galbum
					ORDER BY embedded DESC, created_at ASC NULLS LAST, uri ASC) AS rn,
				first_value(embedding_centered) OVER (PARTITION BY gname, gartist, galbum
					ORDER BY embedded DESC, created_at ASC NULLS LAST, uri ASC) AS keeper_vec
			FROM grouped g
		),
		dupe_groups AS (
			SELECT gname || '|' || gartist || '|' || galbum AS key
			FROM grouped GROUP BY gname, gartist, galbum HAVING count(*) > 1
		),
		unambiguous AS (
			SELECT d.key
			FROM dupe_groups d
			JOIN numbered n
				ON (n.gname || '|' || n.gartist || '|' || n.galbum) = d.key
			WHERE n.rn > 1 AND COALESCE(n.skip, FALSE) = FALSE
			GROUP BY d.key
			HAVING bool_and(
				n.embedding_centered IS NULL OR n.keeper_vec IS NULL
				OR (1 - (n.embedding_centered <=> n.keeper_vec)) >= ${MIXED_AUDIO_THRESHOLD}
			)
		)
		SELECT key FROM unambiguous ORDER BY key LIMIT ${limit}
	`);
	return (rows as unknown as Array<{ key: string }>).map((r) => r.key);
}

export const POST: RequestHandler = async ({ request, locals }) => {
	// A bulk prune soft-deletes thousands of rows, so it is deliberately not
	// reachable with the plain WORKER_TOKEN the scheduled jobs use. It needs a
	// real signed-in session.
	if (locals.method === 'service') {
		return Response.json({ error: 'bulk prune requires a signed-in session' }, { status: 403 });
	}

	let body: { action?: unknown; limit?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return Response.json({ error: 'request body must be valid JSON' }, { status: 400 });
	}

	if (body.action === 'plan') {
		try {
			return Response.json(await bulkPlan());
		} catch (error) {
			console.error('[duplicates] bulk plan failed:', error);
			return Response.json({ error: String(error) }, { status: 500 });
		}
	}

	if (body.action !== 'prune') {
		return Response.json({ error: "action must be 'plan' or 'prune'" }, { status: 400 });
	}

	const requested = Number(body.limit ?? BATCH_GROUPS);
	const limit = Number.isFinite(requested)
		? Math.min(Math.max(Math.trunc(requested), 1), 5000)
		: BATCH_GROUPS;

	try {
		const keys = await bulkKeys(limit);
		if (keys.length === 0) {
			return Response.json({ ok: true, affected: 0, done: true });
		}
		const affected = await applyDuplicateSkip(keys);
		// One more key than the page size means there is more to do.
		return Response.json({ ok: true, affected, groups: keys.length, done: keys.length < limit });
	} catch (error) {
		console.error('[duplicates] bulk prune failed:', error);
		return Response.json({ error: String(error) }, { status: 500 });
	}
};

/** Summary of the full population, for the page header. */
export const GET: RequestHandler = async () => {
	try {
		const [summary, plan] = await Promise.all([findDuplicates(0), bulkPlan()]);
		return Response.json({ ...summary, bulk: plan });
	} catch (error) {
		console.error('[duplicates] bulk summary failed:', error);
		return Response.json({ error: String(error) }, { status: 500 });
	}
};
