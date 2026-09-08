import { ARTISTS_TO_ADD } from '$lib/server/add-artists';
import { getLastRuns, relativeTime, type LastRun } from '$lib/server/job-log';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const lastRuns = await getLastRuns().catch(
		() => ({}) as Record<string, LastRun | null>
	);
	return {
		defaultArtistCount: ARTISTS_TO_ADD.length,
		lastRuns: Object.fromEntries(
			Object.entries(lastRuns).map(([job, run]) => [
				job,
				run
					? {
							ok: run.ok,
							detail: run.detail,
							when: relativeTime(run.finishedAt)
						}
					: null
			])
		) as Record<string, { ok: boolean | null; detail: string | null; when: string } | null>
	};
};
