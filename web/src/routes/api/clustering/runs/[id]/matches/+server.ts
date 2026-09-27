import { asc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { clusterRunMatchTable } from '$lib/server/schema';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const id = Number(params.id);
	if (!Number.isSafeInteger(id) || id < 1) {
		return Response.json({ error: 'Invalid cluster run id' }, { status: 400 });
	}

	try {
		const matches = await db
			.select()
			.from(clusterRunMatchTable)
			.where(eq(clusterRunMatchTable.runId, id))
			.orderBy(asc(clusterRunMatchTable.clusterId));
		return Response.json({ runId: id, matches });
	} catch (error) {
		console.error('Cluster run match lookup failed:', error);
		return Response.json({ error: String(error) }, { status: 500 });
	}
};
