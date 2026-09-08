import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { likedSongsTable, trackTable } from '$lib/server/schema';
import { CLUSTER_NAMES } from '$lib/clusters';
import { recommend, validateTrackUris } from '$lib/server/recomendation-engine';
import { getActiveSchedule, getVibeClusterIds, listSchedules, setVibeClusterIds } from '$lib/server/vibe-store';
import { setQueue } from '$lib/server/queue';
import { playSongs } from '$lib/server/webhook';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	const [clusterIds, schedules, active] = await Promise.all([
		getVibeClusterIds(),
		listSchedules(),
		getActiveSchedule()
	]);
	return Response.json({
		success: true,
		clusterIds,
		names: CLUSTER_NAMES,
		schedules,
		activeSchedule: active
	});
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = (await request.json().catch(() => ({}))) as {
			clusterIds?: number[];
			useSchedule?: boolean;
			saveOnly?: boolean;
		};
		let clusterIds: number[];
		if (body.useSchedule) {
			const activeSchedule = await getActiveSchedule();
			clusterIds =
				activeSchedule?.clusterIds?.length
					? [...activeSchedule.clusterIds]
					: await getVibeClusterIds();
		} else if (Array.isArray(body.clusterIds) && body.clusterIds.length > 0) {
			clusterIds = await setVibeClusterIds(body.clusterIds);
		} else {
			clusterIds = await getVibeClusterIds();
		}
		if (body.saveOnly) {
			return Response.json({ success: true, clusterIds, saved: true });
		}

		// Select 5 random tracks from these clusters as seeds
		const seeds = await db
			.select({ uri: trackTable.uri })
			.from(trackTable)
			.innerJoin(likedSongsTable, eq(trackTable.uri, likedSongsTable.uri))
			.where(and(inArray(trackTable.clusterId, clusterIds), eq(trackTable.skip, false)))
			.orderBy(sql`random()`)
			.limit(5);

		const recommendations = await recommend({
			seedUris: seeds.map((s) => s.uri),
			limit: 50,
			annPool: 800,
			alphaNow: 0.8,
			maxPerArtist: 4,
			clusterIds
		});

		if (recommendations.length > 0) {
			const tracks = await validateTrackUris(recommendations);
			setQueue(tracks);
			await playSongs(tracks.map((t) => t.uri));
			return Response.json({ success: true, tracks });
		} else {
			return Response.json(
				{ success: false, error: 'No recommendations generated' },
				{ status: 500 }
			);
		}
	} catch (error) {
		console.error('Vibe playback failed:', error);
		return Response.json({ success: false, error: String(error) }, { status: 500 });
	}
};
