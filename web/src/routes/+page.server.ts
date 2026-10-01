import { getCurrentTrack } from '$lib/server/webhook';
import {
	getPlayerState,
	getQueues,
	preferredPlayerName,
	type QueueSnapshot
} from '$lib/server/player';
import { getActiveSchedule, getVibeClusterIds, listSchedules } from '$lib/server/vibe-store';
import { getActiveClusterMetadata } from '$lib/server/active-clusters';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const [nowPlaying, player, queueState, clusterIds, schedules, activeSchedule, clusterMetadata] = await Promise.all(
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
			getActiveSchedule().catch(() => null),
			getActiveClusterMetadata()
		]
	);

	return {
		nowPlaying,
		player,
		queueState,
		vibeClusterIds: clusterIds,
		vibeSchedules: schedules,
		activeSchedule,
		clusterNames: clusterMetadata.names,
		scheduleTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		// Drives the empty-state banner. "Configured" is not the same as
		// "reachable"; the queues panel reports that separately.
		musicAssistant: Boolean(process.env.MUSIC_HOST?.trim() && process.env.MA_TOKEN?.trim())
	};
};
