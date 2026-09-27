import { desc } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { clusterRunTable } from '$lib/server/schema';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const requestedLimit = Number(url.searchParams.get('limit') ?? 25);
		const limit = Number.isFinite(requestedLimit)
			? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100)
			: 25;
		// Selecting the table rather than restating every column means a schema
		// change cannot leave this projection quietly behind.
		const runs = await db
			.select()
			.from(clusterRunTable)
			.orderBy(desc(clusterRunTable.id))
			.limit(limit);
		return Response.json({ runs });
	} catch (error) {
		console.error('Cluster run listing failed:', error);
		return Response.json({ error: String(error) }, { status: 500 });
	}
};
