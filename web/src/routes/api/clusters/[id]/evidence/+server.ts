import { getClusterEvidence } from '$lib/server/cluster-evidence';
import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import type { RequestHandler } from './$types';

/** Latest applied clustering run, if any. */
async function activeRunId(): Promise<number | null> {
	try {
		const rows = (await db.execute(sql`
			SELECT id FROM cluster_run
			WHERE status = 'applied'
			ORDER BY applied_at DESC NULLS LAST, id DESC
			LIMIT 1
		`)) as unknown as Array<{ id: number }>;
		return rows[0]?.id ?? null;
	} catch {
		return null;
	}
}

export const GET: RequestHandler = async ({ params }) => {
	const clusterId = Number(params.id);
	if (!Number.isInteger(clusterId) || clusterId < 0) {
		return Response.json({ error: 'cluster id must be a non-negative integer' }, { status: 400 });
	}

	const [evidence, runId] = await Promise.all([getClusterEvidence(clusterId), activeRunId()]);
	if (!evidence) {
		return Response.json({ error: 'no evidence available' }, { status: 404 });
	}

	// The panel shows the stored name separately from the evidence, so a
	// missing name is visible rather than silently falling back.
	let displayName: string | null = null;
	if (runId !== null) {
		try {
			const rows = (await db.execute(sql`
				SELECT display_name FROM cluster_run_match
				WHERE run_id = ${runId} AND cluster_id = ${clusterId}
			`)) as unknown as Array<{ display_name: string }>;
			displayName = rows[0]?.display_name ?? null;
		} catch {
			displayName = null;
		}
	}

	return Response.json({ evidence, runId, displayName });
};
