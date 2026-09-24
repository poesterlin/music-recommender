import { playQueueItem } from '$lib/server/player';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = (await request.json().catch(() => ({}))) as {
			queueId?: unknown;
			queueItemId?: unknown;
		};

		if (
			typeof body.queueId !== 'string' ||
			!body.queueId.trim() ||
			typeof body.queueItemId !== 'string' ||
			!body.queueItemId.trim()
		) {
			return Response.json(
				{ success: false, error: 'queueId and queueItemId are required' },
				{ status: 400 }
			);
		}

		await playQueueItem(body.queueId, body.queueItemId);
		return Response.json({ success: true });
	} catch (error) {
		console.error('queue item playback failed:', error);
		return Response.json({ success: false, error: String(error) }, { status: 500 });
	}
};
