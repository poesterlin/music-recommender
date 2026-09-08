import { getCurrentTrack } from '$lib/server/webhook';
import { getPlayerState } from '$lib/server/player';
import { getActiveSchedule, getVibeClusterIds, listSchedules } from '$lib/server/vibe-store';
import { getQueue } from '$lib/server/queue';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const [nowPlaying, player, clusterIds, schedules, activeSchedule] = await Promise.all([
		getCurrentTrack().catch(() => null),
		getPlayerState().catch(() => null),
		getVibeClusterIds().catch(() => [] as number[]),
		listSchedules().catch(() => []),
		getActiveSchedule().catch(() => null)
	]);

	return {
		nowPlaying,
		player,
		vibeClusterIds: clusterIds,
		vibeSchedules: schedules,
		activeSchedule,
		queue: getQueue()
	};
};
