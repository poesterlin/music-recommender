import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { trackTable } from '$lib/server/schema';
import { CLUSTER_NAMES } from '$lib/clusters';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	try {
		const samples = await db
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
			.limit(400);

		const seen = new Map<number, (typeof samples)[number]>();
		for (const s of samples) {
			if (s.clusterId !== null && !seen.has(s.clusterId)) seen.set(s.clusterId, s);
		}
		// Every known cluster gets a card — even without an indexed preview
		// track, so numbering never has mystery gaps.
		const clusters = Object.keys(CLUSTER_NAMES)
			.map(Number)
			.sort((a, b) => a - b)
			.map((id) => {
				const s = seen.get(id);
				return {
					clusterId: id,
					uri: s?.uri ?? null,
					name: s?.name ?? null,
					artists: s?.artists ?? [],
					album: s?.album ?? ''
				};
			});
		return { clusters };
	} catch {
		return { clusters: [] };
	}
};
