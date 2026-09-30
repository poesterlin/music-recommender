import { getLastRuns, relativeTime, type JobSource, type LastRun } from '$lib/server/job-log';
import type { PageServerLoad } from './$types';
import { getEmbeddingSettings } from '$lib/server/embedding-settings';

export const load: PageServerLoad = async () => {
	const lastRuns = await getLastRuns().catch(() => ({}) as Record<string, LastRun | null>);
	return {
		embeddingSettings: await getEmbeddingSettings(),
		// Every one of these jobs reads Music Assistant, so they cannot run
		// without it. Configured is not the same as reachable; a failed run
		// still reports itself in the job list.
		musicAssistant: Boolean(process.env.MUSIC_HOST?.trim() && process.env.MA_TOKEN?.trim()),
		lastRuns: Object.fromEntries(
			Object.entries(lastRuns).map(([job, run]) => [
				job,
				run
					? {
							ok: run.ok,
							detail: run.detail,
							source: run.source,
							when: relativeTime(run.finishedAt)
						}
					: null
			])
		) as Record<
			string,
			{ ok: boolean | null; detail: string | null; source: JobSource; when: string } | null
		>
	};
};
