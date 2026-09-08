import { getCurrentTrack } from '$lib/server/webhook';
import { getPlayerState, getUpNext } from '$lib/server/player';
import { getActiveSchedule, getVibeClusterIds, listSchedules } from '$lib/server/vibe-store';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const [nowPlaying, player, upNext, clusterIds, schedules, activeSchedule] = await Promise.all([
		getCurrentTrack().catch(() => null),
		getPlayerState().catch(() => null),
		getUpNext().catch(() => []),
		getVibeClusterIds().catch(() => [] as number[]),
		listSchedules().catch(() => []),
		getActiveSchedule().catch(() => null)
	]);

	return {
		nowPlaying,
		player,
		upNext,
		vibeClusterIds: clusterIds,
		vibeSchedules: schedules,
		activeSchedule
	};
};
