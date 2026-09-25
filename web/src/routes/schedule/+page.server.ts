import { getActiveClusterMetadata } from '$lib/server/active-clusters';
import { getActiveSchedule, listSchedules } from '$lib/server/vibe-store';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const [schedules, activeSchedule, clusterMetadata] = await Promise.all([
		listSchedules().catch(() => []),
		getActiveSchedule().catch(() => null),
		getActiveClusterMetadata()
	]);
	return {
		schedules,
		activeSchedule,
		availableClusterIds: clusterMetadata.ids,
		clusterNames: clusterMetadata.names
	};
};
