/**
 * In-process schedules for the maintenance jobs.
 *
 * These replace one `curlimages/curl` container per job, each running
 * `while true; do curl ...; sleep N; done`. `Bun.cron` is a better fit because
 * it fixes the three things that loop got wrong:
 *
 *   - No overlap. Bun schedules the next fire only once the handler settles, so
 *     a job that overruns its interval is delayed rather than stacked.
 *   - Wall-clock anchors. A cron expression names an instant, not "an hour
 *     after the last run", so the schedule cannot drift and the jobs cannot
 *     pile onto the same tick.
 *   - Testable. The schedules are unit-tested with fake timers.
 *
 * The tradeoff is that scheduling now rides on this process: if the web
 * container is down the jobs do not run. That is acceptable here because the
 * jobs are defined *in* this process, and `recordJobRun` still reports every
 * attempt that starts.
 *
 * There is no leader election, so a second web replica would run every job too.
 * The jobs are idempotent — change-only upserts, `onConflictDoNothing`, and
 * cluster assignment that only touches unclustered tracks — so that would waste
 * work rather than corrupt anything. The Compose stack is single-replica.
 */

import { runAnalyze, runSyncFavorites } from './jobs';

/**
 * Minutes are deliberately off the hour: the two jobs have different natural
 * periods, and pinning them to distinct minutes keeps them from contending.
 */
export const SCHEDULES = {
	/**
	 * Hourly. The listener hearts tracks from other clients, and the sync is
	 * cheap — a filtered page and an insert that conflicts with nothing.
	 */
	syncFavorites: '7 * * * *',
	/** Matches the old six-hourly analyzer cadence. */
	analyze: '23 */6 * * *'
} as const;

let jobs: Bun.CronJob[] = [];

/** Whether the environment can actually run these jobs. */
function isConfigured(): boolean {
	return Boolean(process.env.MUSIC_HOST?.trim() && process.env.MA_TOKEN?.trim());
}

/**
 * Register the schedules. Idempotent, and a no-op when Music Assistant is not
 * configured — a web-only local install has no library to maintain, and
 * recording a failed run every hour would just be noise. The caller is
 * responsible for skipping this during prerender.
 */
export function startScheduledJobs(): void {
	if (jobs.length > 0) return;
	if (!isConfigured()) {
		console.warn('[scheduler] MUSIC_HOST/MA_TOKEN not set; scheduled jobs are disabled');
		return;
	}

	jobs = [
		Bun.cron(SCHEDULES.syncFavorites, () => {
			void runSyncFavorites('automatic');
		}),
		Bun.cron(SCHEDULES.analyze, () => {
			void runAnalyze('automatic');
		})
	];

	// Never hold the process open on account of a schedule.
	for (const job of jobs) job.unref();
}

/** Cancel the schedules. Used by tests. */
export function stopScheduledJobs(): void {
	for (const job of jobs) job.stop();
	jobs = [];
}
