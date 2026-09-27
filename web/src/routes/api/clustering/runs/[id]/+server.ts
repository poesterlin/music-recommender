import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { clusterRunTable } from '$lib/server/schema';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const id = Number(params.id);
	if (!Number.isSafeInteger(id) || id < 1) {
		return Response.json({ error: 'Invalid cluster run id' }, { status: 400 });
	}

	try {
		const [run] = await db
			.select()
			.from(clusterRunTable)
			.where(eq(clusterRunTable.id, id))
			.limit(1);
		return Response.json({ run: run ?? null });
	} catch (error) {
		console.error('Cluster run lookup failed:', error);
		return Response.json({ error: String(error) }, { status: 500 });
	}
};
