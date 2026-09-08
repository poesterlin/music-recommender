import { getCurrentTrack, playSongs } from '$lib/server/webhook';
import { recommend, validateTrackUris } from '$lib/server/recomendation-engine';
import { getQueue, setQueue } from '$lib/server/queue';
import type { RequestHandler } from './$types';

const FALLBACK_SEEDS = [
	'library://track/532', // Billie Eilish - ocean eyes
	'library://track/7333', // The xx - On Hold
	'library://track/784' // Flume - Bring You Down,
];

async function refreshQueueInBackground(): Promise<void> {
	try {
		const result = await recommend({
			seedUris: FALLBACK_SEEDS,
			limit: 60,
			annPool: 800,
			alphaNow: 0.7,
			maxPerArtist: 1
		});
		setQueue(await validateTrackUris(result));
		console.log('Tracks ready for playback:', getQueue().length);
	} catch (error) {
		console.error('Error generating tracks:', error);
	}
}

export const GET: RequestHandler = async () => {
	const state = await getCurrentTrack();
	if (!state) {
		return new Response('No track found', { status: 404 });
	}
	return Response.json(state);
};

export const POST: RequestHandler = async () => {
	// validate and play cached tracks (generate first if the cache is empty,
	// e.g. right after a restart — the old server prefetched this at boot)
	let queue = getQueue();
	if (!queue.length) {
		await refreshQueueInBackground();
		queue = getQueue();
	}
	const validated = await validateTrackUris(queue);
	const ids = validated.map((t) => t.uri);
	await playSongs(ids);

	// prepare next tracks in the background
	void refreshQueueInBackground();

	return Response.json({ success: true, tracks: validated });
};
