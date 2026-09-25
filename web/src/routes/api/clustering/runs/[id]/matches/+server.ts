import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const id = Number(params.id);
	if (!Number.isSafeInteger(id) || id < 1) {
		return Response.json({ error: 'Invalid cluster run id' }, { status: 400 });
	}

	try {
		const matches = await db.execute(sql`
			SELECT
				run_id,
				cluster_id,
				legacy_cluster_id,
				legacy_name,
				display_name,
				overlap_count,
				new_cluster_count,
				legacy_cluster_count,
				confidence,
				related_legacy_ids,
				created_at
			FROM cluster_run_match
			WHERE run_id = ${id}
			ORDER BY cluster_id
		`);
		return Response.json({ runId: id, matches });
	} catch (error) {
		console.error('Cluster run match lookup failed:', error);
		return Response.json({ error: String(error) }, { status: 500 });
	}
};
