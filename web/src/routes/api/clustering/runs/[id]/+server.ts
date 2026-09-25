import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const id = Number(params.id);
	if (!Number.isSafeInteger(id) || id < 1) {
		return Response.json({ error: 'Invalid cluster run id' }, { status: 400 });
	}

	try {
		const rows = await db.execute(sql`
			SELECT
				id,
				status,
				mode,
				config,
				report,
				report_path,
				assignments_path,
				track_count,
				dimensions,
				created_at,
				completed_at,
				applied_at
			FROM cluster_run
			WHERE id = ${id}
			LIMIT 1
		`);
		return Response.json({ run: rows[0] ?? null });
	} catch (error) {
		console.error('Cluster run lookup failed:', error);
		return Response.json({ error: String(error) }, { status: 500 });
	}
};
