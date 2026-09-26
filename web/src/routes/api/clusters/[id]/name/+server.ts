import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import type { RequestHandler } from './$types';

const MAX_NAME_LENGTH = 120;

async function activeRunId(): Promise<number | null> {
	const rows = (await db.execute(sql`
		SELECT id FROM cluster_run
		WHERE status = 'applied'
		ORDER BY applied_at DESC NULLS LAST, id DESC
		LIMIT 1
	`)) as unknown as Array<{ id: number }>;
	return rows[0]?.id ?? null;
}

function readName(body: unknown): string | null | undefined {
	if (!body || typeof body !== 'object') return undefined;
	const value = (body as { name?: unknown }).name;
	if (value === null) return null;
	if (typeof value !== 'string') return undefined;
	const trimmed = value.replace(/\s+/g, ' ').trim();
	if (trimmed.length > MAX_NAME_LENGTH) {
		throw new RangeError(`name must be ${MAX_NAME_LENGTH} characters or fewer`);
	}
	return trimmed;
}

export const GET: RequestHandler = async ({ params }) => {
	const clusterId = Number(params.id);
	if (!Number.isInteger(clusterId) || clusterId < 0) {
		return Response.json({ error: 'cluster id must be a non-negative integer' }, { status: 400 });
	}
	const runId = await activeRunId();
	if (runId === null) {
		return Response.json({ error: 'no applied clustering run to name' }, { status: 409 });
	}
	const rows = (await db.execute(sql`
		SELECT display_name FROM cluster_run_match
		WHERE run_id = ${runId} AND cluster_id = ${clusterId}
	`)) as unknown as Array<{ display_name: string }>;
	if (rows.length === 0) {
		return Response.json({ error: 'cluster is not part of the active run' }, { status: 404 });
	}
	return Response.json({ name: rows[0].display_name, runId });
};

export const PUT: RequestHandler = async ({ params, request }) => {
	const clusterId = Number(params.id);
	if (!Number.isInteger(clusterId) || clusterId < 0) {
		return Response.json({ error: 'cluster id must be a non-negative integer' }, { status: 400 });
	}

	let name: string | null;
	try {
		const parsed = readName(await request.json());
		if (parsed === undefined) {
			return Response.json({ error: 'name must be a string or null' }, { status: 400 });
		}
		name = parsed;
	} catch (error) {
		if (error instanceof RangeError) {
			return Response.json({ error: error.message }, { status: 400 });
		}
		return Response.json({ error: 'request body must be valid JSON' }, { status: 400 });
	}

	try {
		const runId = await activeRunId();
		if (runId === null) {
			return Response.json({ error: 'no applied clustering run to name' }, { status: 409 });
		}
		// null restores the generic label by clearing the override.
		const result =
			name === null
				? await db.execute(sql`
				UPDATE cluster_run_match SET display_name = ''
				WHERE run_id = ${runId} AND cluster_id = ${clusterId}
			`)
				: await db.execute(sql`
				UPDATE cluster_run_match SET display_name = ${name}
				WHERE run_id = ${runId} AND cluster_id = ${clusterId}
			`);

		const count = Array.isArray(result) ? result.length : 0;
		if (count === 0) {
			return Response.json({ error: 'cluster is not part of the active run' }, { status: 404 });
		}
		return Response.json({ ok: true, name, runId });
	} catch (error) {
		console.error('Cluster rename failed:', error);
		return Response.json({ error: String(error) }, { status: 500 });
	}
};
