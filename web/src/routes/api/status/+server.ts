import { getPipelineStatus } from '$lib/server/pipeline-status';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	try {
		return Response.json(await getPipelineStatus());
	} catch (error) {
		console.error('Pipeline status failed:', error);
		return Response.json({ error: String(error) }, { status: 500 });
	}
};
