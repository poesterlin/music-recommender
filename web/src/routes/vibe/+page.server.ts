import { getActiveSchedule, getVibeClusterIds, listSchedules } from '$lib/server/vibe-store';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const [clusterIds, schedules, activeSchedule] = await Promise.all([
		getVibeClusterIds().catch(() => [] as number[]),
		listSchedules().catch(() => []),
		getActiveSchedule().catch(() => null)
	]);
	return { vibeClusterIds: clusterIds, vibeSchedules: schedules, activeSchedule };
};
