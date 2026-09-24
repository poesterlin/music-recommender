import { getCurrentTrack } from '$lib/server/webhook';
import {
	getPlayerState,
	getQueues,
	preferredPlayerName,
	type QueueSnapshot
} from '$lib/server/player';
import { getActiveSchedule, getVibeClusterIds, listSchedules } from '$lib/server/vibe-store';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const [nowPlaying, player, queueState, clusterIds, schedules, activeSchedule] = await Promise.all(
		[
			getCurrentTrack().catch(() => null),
			getPlayerState().catch(() => null),
			getQueues().catch((): QueueSnapshot => ({
				scope: preferredPlayerName() ? 'main' : 'all',
				mainPlayer: preferredPlayerName(),
				queues: []
			})),
			getVibeClusterIds().catch(() => [] as number[]),
			listSchedules().catch(() => []),
			getActiveSchedule().catch(() => null)
		]
	);

	return {
		nowPlaying,
		player,
		queueState,
		vibeClusterIds: clusterIds,
		vibeSchedules: schedules,
		activeSchedule
	};
};
