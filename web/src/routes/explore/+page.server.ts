import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { trackTable } from '$lib/server/schema';
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
			.limit(200);

		const seen = new Map<number, (typeof samples)[number]>();
		for (const s of samples) {
			if (s.clusterId !== null && !seen.has(s.clusterId)) seen.set(s.clusterId, s);
		}
		const clusters = [...seen.values()]
			.sort((a, b) => (a.clusterId || 0) - (b.clusterId || 0))
			.map((s) => ({
				clusterId: s.clusterId as number,
				uri: s.uri,
				name: s.name,
				artists: s.artists,
				album: s.album
			}));
		return { clusters };
	} catch {
		return { clusters: [] };
	}
};
