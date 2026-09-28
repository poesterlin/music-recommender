import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { getEmbeddingSpaceUsage, describeSpace } from '$lib/server/embedding-spaces';
import type { RequestHandler } from './$types';

/**
 * The embedding recipes in use and how many rows each one produced.
 *
 * Read-only, and deliberately not token-gated: knowing which settings produced
 * a vector is diagnostic information, not an action.
 */
export const GET: RequestHandler = async () => {
	const report = await getEmbeddingSpaceUsage();
	return Response.json({
		success: true,
		activeVersion: report.activeVersion,
		mixed: report.mixed,
		totalEmbedded: report.totalEmbedded,
		spaces: report.spaces.map((space) => ({ ...space, summary: describeSpace(space) }))
	});
};

/** Register a recipe, or report the version already registered for it. */
export const PUT: RequestHandler = async ({ request, locals }) => {
	if (locals.method === 'service') {
		return Response.json({ error: 'session required' }, { status: 403 });
	}
	const body = (await request.json().catch(() => null)) as {
		hopSeconds?: unknown;
		maxSampleSeconds?: unknown;
		frontend?: unknown;
		dryRun?: unknown;
	} | null;

	const hopSeconds = Number(body?.hopSeconds);
	const maxSampleSeconds = Number(body?.maxSampleSeconds);
	if (!Number.isFinite(hopSeconds) || !Number.isFinite(maxSampleSeconds)) {
		return Response.json(
			{ error: 'hopSeconds and maxSampleSeconds must both be numbers' },
			{ status: 400 }
		);
	}

	const { ensureEmbeddingSpace } = await import('$lib/server/embedding-spaces');
	try {
		const result = await ensureEmbeddingSpace({
			hopSeconds,
			maxSampleSeconds,
			frontend: typeof body?.frontend === 'string' ? body.frontend : undefined,
			dryRun: body?.dryRun === true
		});
		return Response.json({ success: true, ...result });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const status = /already spans|re-embed/.test(message) ? 409 : 400;
		return Response.json({ error: message }, { status });
	}
};

/** Stamp rows that were embedded before the settings existed. */
export const POST: RequestHandler = async ({ locals }) => {
	if (locals.method === 'service') {
		return Response.json({ error: 'session required' }, { status: 403 });
	}
	// Older rows carry a version but no settings. Backfilling the shipped
	// defaults is only correct while every historical embedding used them.
	const rows = (await db.execute(sql`
		UPDATE embedding_space
		SET hop_seconds = 0.1, max_sample_seconds = 60, frontend = COALESCE(frontend, 'kapre')
		WHERE hop_seconds IS NULL OR max_sample_seconds IS NULL
		RETURNING version, hop_seconds, max_sample_seconds
	`)) as unknown as Array<{ version: number; hop_seconds: number; max_sample_seconds: number }>;

	return Response.json({
		success: true,
		backfilled: rows.length,
		spaces: rows.map((r) => `v${r.version} hop=${r.hop_seconds}s max=${r.max_sample_seconds}s`)
	});
};
