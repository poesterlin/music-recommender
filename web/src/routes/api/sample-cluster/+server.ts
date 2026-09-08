import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { trackTable } from '$lib/server/schema';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const clusterId = Number(url.searchParams.get('clusterId') || '-1');
	const samples = await db
		.select({
			uri: trackTable.uri,
			name: trackTable.name,
			artists: trackTable.artist,
			album: trackTable.album
		})
		.from(trackTable)
		.where(sql`${trackTable.clusterId} = ${clusterId}`)
		.orderBy(sql`random()`)
		.limit(30);

	return Response.json({ success: true, tracks: samples });
};
