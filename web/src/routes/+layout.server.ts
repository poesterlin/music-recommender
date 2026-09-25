import { getCurrentTrack } from '$lib/server/webhook';
import { getWorkerStatus } from '$lib/server/job-log';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) {
		return { nowPlaying: null, user: locals.user, workerLastSeenAt: null };
	}
	const [nowPlaying, worker] = await Promise.all([
		getCurrentTrack().catch(() => null),
		getWorkerStatus().catch(() => null)
	]);
	return {
		nowPlaying,
		user: locals.user,
		// Drives the header badge. Uploads are the worker's only heartbeat, so
		// this is the difference between "working" and "stopped" being visible.
		workerLastSeenAt: worker?.lastSeenAt ?? null
	};
};
