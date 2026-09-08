import { desc } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { trackTable } from '$lib/server/schema';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	try {
		const tracks = await db
			.select({
				uri: trackTable.uri,
				name: trackTable.name,
				artists: trackTable.artist,
				album: trackTable.album,
				createdAt: trackTable.createdAt
			})
			.from(trackTable)
			.orderBy(desc(trackTable.createdAt))
			.limit(100);
		return { tracks };
	} catch {
		return { tracks: [] };
	}
};
