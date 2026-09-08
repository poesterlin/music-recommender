import { desc, eq } from 'drizzle-orm';
import { db } from './db';
import { jobRunTable } from './schema';

export const JOB_IDS = ['index-library', 'sync-favorites', 'analyze'] as const;
export type JobId = (typeof JOB_IDS)[number];

export type LastRun = {
	ok: boolean | null;
	detail: string | null;
	finishedAt: string | null;
};

/** Record a finished job run. Never throws (logging must not break jobs). */
export async function recordJobRun(job: string, ok: boolean, detail?: string): Promise<void> {
	try {
		await db.insert(jobRunTable).values({
			job,
			finishedAt: new Date().toISOString(),
			ok,
			detail: detail ?? null
		});
	} catch (e) {
		console.warn('[job-log] record failed:', e);
	}
}

/** Latest finished run per job id. */
export async function getLastRuns(): Promise<Record<string, LastRun | null>> {
	const out: Record<string, LastRun | null> = {};
	for (const job of JOB_IDS) {
		try {
			const [row] = await db
				.select({ ok: jobRunTable.ok, detail: jobRunTable.detail, finishedAt: jobRunTable.finishedAt })
				.from(jobRunTable)
				.where(eq(jobRunTable.job, job))
				.orderBy(desc(jobRunTable.id))
				.limit(1);
			out[job] = row ?? null;
		} catch {
			out[job] = null;
		}
	}
	return out;
}

/** "2h ago", "3d ago", or a short date for older runs. */
export function relativeTime(iso: string | null): string {
	if (!iso) return 'never';
	const t = new Date(iso).getTime();
	if (isNaN(t)) return 'never';
	const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	if (hours < 48) return `${hours}h ago`;
	return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
