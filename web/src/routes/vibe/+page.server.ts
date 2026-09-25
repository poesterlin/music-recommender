import { getActiveClusterMetadata } from '$lib/server/active-clusters';
import { getActiveSchedule, getVibeClusterIds, listSchedules } from '$lib/server/vibe-store';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const [clusterIds, schedules, activeSchedule, clusterMetadata] = await Promise.all([
		getVibeClusterIds().catch(() => [] as number[]),
		listSchedules().catch(() => []),
		getActiveSchedule().catch(() => null),
		getActiveClusterMetadata()
	]);
	return {
		vibeClusterIds: clusterIds,
		vibeSchedules: schedules,
		activeSchedule,
		availableClusterIds: clusterMetadata.ids,
		clusterNames: clusterMetadata.names
	};
};
