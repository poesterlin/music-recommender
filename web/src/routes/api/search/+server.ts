import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { trackTable } from '$lib/server/schema';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const query = url.searchParams.get('q');
	if (!query) return Response.json({ success: true, tracks: [] });

	const matches = await db
		.select({
			uri: trackTable.uri,
			name: trackTable.name,
			artists: trackTable.artist
		})
		.from(trackTable)
		.where(sql`${trackTable.name} ILIKE ${'%' + query + '%'}`)
		.limit(10);

	return Response.json({ success: true, tracks: matches });
};
