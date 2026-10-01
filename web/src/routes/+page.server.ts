import { getCurrentTrack } from '$lib/server/webhook';
import {
	getPlayerState,
	getQueues,
	preferredPlayerName,
	type QueueSnapshot
} from '$lib/server/player';
import { getActiveSchedule, getVibeClusterIds, listSchedules } from '$lib/server/vibe-store';
import { getActiveClusterMetadata } from '$lib/server/active-clusters';
import { getClusterCovers, getClusterTrackCounts } from '$lib/server/cover-image';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const [nowPlaying, player, queueState, clusterIds, schedules, activeSchedule, clusterMetadata] =
		await Promise.all([
			getCurrentTrack().catch(() => null),
			getPlayerState().catch(() => null),
			getQueues().catch(async (): Promise<QueueSnapshot> => {
				const mainPlayer = await preferredPlayerName().catch(() => null);
				return { scope: mainPlayer ? 'main' : 'all', mainPlayer, queues: [] };
			}),
			getVibeClusterIds().catch(() => [] as number[]),
			listSchedules().catch(() => []),
			getActiveSchedule().catch(() => null),
			getActiveClusterMetadata()
		]);

	const [covers, trackCounts] = await Promise.all([
		getClusterCovers().catch(
			() => ({}) as Record<number, { primary: string; secondary: string | null }>
		),
		getClusterTrackCounts().catch(() => ({}) as Record<number, number>)
	]);

	return {
		covers,
		trackCounts,
		availableClusterIds: clusterMetadata.ids,
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
