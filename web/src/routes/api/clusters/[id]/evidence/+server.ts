import { getClusterEvidence } from '$lib/server/cluster-evidence';
import { getActiveClusterMetadata } from '$lib/server/active-clusters';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const clusterId = Number(params.id);
	if (!Number.isInteger(clusterId) || clusterId < 0) {
		return Response.json({ error: 'cluster id must be a non-negative integer' }, { status: 400 });
	}
	const [evidence, metadata] = await Promise.all([
		getClusterEvidence(clusterId),
		getActiveClusterMetadata()
	]);
	if (!evidence) return Response.json({ error: 'no evidence available' }, { status: 404 });
	return Response.json({
		evidence,
		runId: metadata.activeRun?.id ?? null,
		displayName: metadata.names[clusterId] ?? null,
		humanNamed: metadata.manualNameIds.includes(clusterId)
	});
};
