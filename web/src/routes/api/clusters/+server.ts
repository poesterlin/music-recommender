import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { trackTable } from '$lib/server/schema';
import { setQueue } from '$lib/server/queue';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	// Fetch random tracks to act as one "preview" per cluster
	const samples = await db
		.select({
			clusterId: trackTable.clusterId,
			uri: trackTable.uri,
			name: trackTable.name,
			artists: trackTable.artist,
			album: trackTable.album,
			similarity: sql`0`.as<number>()
		})
		.from(trackTable)
		.where(sql`${trackTable.clusterId} IS NOT NULL`)
		.orderBy(sql`random()`)
		.limit(200);

	setQueue(samples);

	// Group by clusterId and take the first one found for each
	const uniqueClusters = Array.from(new Set(samples.map((s) => s.clusterId)))
		.map((id) => samples.find((s) => s.clusterId === id))
		.sort((a, b) => (a?.clusterId || 0) - (b?.clusterId || 0));

	return Response.json(uniqueClusters);
};
