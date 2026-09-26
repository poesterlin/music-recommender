import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { trackTable } from '$lib/server/schema';
import { getActiveClusterMetadata } from '$lib/server/active-clusters';
import { getActiveSchedule, getVibeClusterIds, listSchedules } from '$lib/server/vibe-store';
import { getClusterCovers, getClusterTrackCounts } from '$lib/server/cover-image';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const [clusterIds, schedules, activeSchedule, clusterMetadata, clusters] = await Promise.all([
		getVibeClusterIds().catch(() => [] as number[]),
		listSchedules().catch(() => []),
		getActiveSchedule().catch(() => null),
		getActiveClusterMetadata(),
		// One preview track per cluster for the Browse tab. Random sampling keeps
		// it from looking like a fixed playlist, but it is bounded so the page
		// load stays cheap.
		db
			.select({
				clusterId: trackTable.clusterId,
				uri: trackTable.uri,
				name: trackTable.name,
				artists: trackTable.artist,
				album: trackTable.album
			})
			.from(trackTable)
			.where(sql`${trackTable.clusterId} IS NOT NULL`)
			.orderBy(sql`random()`)
			.limit(400)
			.catch(() => [])
	]);

	const seen = new Map<number, (typeof clusters)[number]>();
	for (const sample of clusters) {
		if (sample.clusterId !== null && !seen.has(sample.clusterId)) {
			seen.set(sample.clusterId, sample);
		}
	}

	const [counts, covers] = await Promise.all([
		getClusterTrackCounts().catch(() => ({}) as Record<number, number>),
		getClusterCovers().catch(
			() => ({}) as Record<number, { primary: string; secondary: string | null }>
		)
	]);

	return {
		vibeClusterIds: clusterIds,
		vibeSchedules: schedules,
		activeSchedule,
		availableClusterIds: clusterMetadata.ids,
		clusterNames: clusterMetadata.names,
		// Only clusters with a human-supplied name are flagged as named, so the
		// tile badge means "someone chose this" rather than "a name exists".
		namedIds: Object.values(clusterMetadata.matches)
			.filter((m) => m.displayName.trim().length > 0)
			.map((m) => m.clusterId),
		trackCounts: counts,
		covers,
		clusters: clusterMetadata.ids.map((id) => {
			const sample = seen.get(id);
			return {
				clusterId: id,
				uri: sample?.uri ?? null,
				name: sample?.name ?? null,
				artists: sample?.artists ?? [],
				album: sample?.album ?? ''
			};
		})
	};
};
