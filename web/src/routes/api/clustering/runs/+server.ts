import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const requestedLimit = Number(url.searchParams.get('limit') ?? 25);
		const limit = Number.isFinite(requestedLimit)
			? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100)
			: 25;
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
			ORDER BY id DESC
			LIMIT ${limit}
		`);
		return Response.json({ runs: rows });
	} catch (error) {
		console.error('Cluster run listing failed:', error);
		return Response.json({ error: String(error) }, { status: 500 });
	}
};
