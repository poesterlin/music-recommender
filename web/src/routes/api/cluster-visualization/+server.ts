import { getClusterProjection } from '$lib/server/cluster-projection';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	try {
		return Response.json(await getClusterProjection());
	} catch (error) {
		console.error('Cluster visualization failed:', error);
		return Response.json({ error: String(error) }, { status: 500 });
	}
};
