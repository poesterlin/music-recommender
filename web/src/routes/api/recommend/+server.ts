import { recommend, validateTrackUris } from '$lib/server/recomendation-engine';
import { setQueue } from '$lib/server/queue';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { seedUris: string[]; limit?: number };
	const recommendations = await recommend({
		seedUris: body.seedUris,
		limit: body.limit ?? 30,
		annPool: 800,
		alphaNow: 0.7,
		maxPerArtist: 3
	});
	const tracks = await validateTrackUris(recommendations);
	setQueue(tracks);
	return Response.json({ success: true, tracks });
};
