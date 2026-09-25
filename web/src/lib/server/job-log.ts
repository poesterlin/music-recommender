import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from './db';
import { jobRunTable } from './schema';

export const JOB_IDS = ['index-library', 'sync-favorites', 'analyze'] as const;
export type JobId = (typeof JOB_IDS)[number];

/**
 * Job name for the portable API worker. The local CPU loop keeps its own
 * `python-local-embeddings` rows, so the two are never conflated on /status.
 */
export const WORKER_JOB = 'python-api-embeddings';

/** Silence longer than this starts a new worker run row instead of extending one. */
const WORKER_RUN_GAP_MS = 10 * 60 * 1000;

const AUTOMATIC_PREFIX = 'Automatic';
const MANUAL_PREFIX = 'Manual';

export type JobSource = 'automatic' | 'manual';

export type LastRun = {
	ok: boolean | null;
	detail: string | null;
	finishedAt: string | null;
	source: JobSource;
};

export type WorkerUpdate = {
	uploaded: number;
	written: number;
	failed: number;
};

type WorkerDetail = {
	processed: number;
	written: number;
	failed: number;
	at: string;
};

export type WorkerStatus = {
	active: boolean;
	lastSeenAt: string | null;
	startedAt: string | null;
	processed: number;
	written: number;
	failed: number;
	secondsPerTrack: number | null;
};

const EMPTY_WORKER: WorkerStatus = {
	active: false,
	lastSeenAt: null,
	startedAt: null,
	processed: 0,
	written: 0,
	failed: 0,
	secondsPerTrack: null
};

function sourceFromDetail(detail: string | null): JobSource {
	return detail?.startsWith(`${AUTOMATIC_PREFIX} `) ? 'automatic' : 'manual';
}

function parseWorkerDetail(raw: string | null): WorkerDetail | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<WorkerDetail>;
		if (typeof parsed.processed !== 'number' || typeof parsed.at !== 'string') return null;
		return {
			processed: parsed.processed,
			written: typeof parsed.written === 'number' ? parsed.written : 0,
			failed: typeof parsed.failed === 'number' ? parsed.failed : 0,
			at: parsed.at
		};
	} catch {
		return null;
	}
}

/** Record a finished job run. Never throws (logging must not break jobs). */
export async function recordJobRun(
	job: string,
	ok: boolean,
	detail?: string,
	source: JobSource = 'manual'
): Promise<void> {
	try {
		// The source is stored as a detail prefix so existing readers keep
		// working without a schema change, and so a scheduled Compose job is
		// distinguishable from the same job triggered by a button.
		const label = source === 'automatic' ? AUTOMATIC_PREFIX : MANUAL_PREFIX;
		await db.insert(jobRunTable).values({
			job,
			finishedAt: new Date().toISOString(),
			ok,
			detail: detail ? `${label} · ${detail}` : label
		});
	} catch (e) {
		console.warn('[job-log] record failed:', e);
	}
}

/**
 * Fold one upload batch into the worker's open run row, or start a new run
 * after a long silence. This is what makes the external worker observable: the
 * worker itself never talks to the database, it only uploads embeddings.
 */
export async function recordWorkerProgress(update: WorkerUpdate): Promise<void> {
	try {
		const now = new Date();
		const nowIso = now.toISOString();
		const [open] = await db
			.select({ id: jobRunTable.id, detail: jobRunTable.detail })
			.from(jobRunTable)
			.where(and(eq(jobRunTable.job, WORKER_JOB), isNull(jobRunTable.finishedAt)))
			.orderBy(desc(jobRunTable.id))
			.limit(1);

		const previous = open ? parseWorkerDetail(open.detail) : null;
		const stale = !open || !previous || now.getTime() - Date.parse(previous.at) > WORKER_RUN_GAP_MS;
		const detail: WorkerDetail = {
			processed: (stale ? 0 : (previous?.processed ?? 0)) + update.uploaded,
			written: (stale ? 0 : (previous?.written ?? 0)) + update.written,
			failed: (stale ? 0 : (previous?.failed ?? 0)) + update.failed,
			at: nowIso
		};

		if (open && !stale) {
			await db
				.update(jobRunTable)
				.set({ detail: JSON.stringify(detail) })
				.where(eq(jobRunTable.id, open.id));
			return;
		}
		if (open) {
			// Close the previous run so run history stays readable.
			await db
				.update(jobRunTable)
				.set({ finishedAt: nowIso, ok: true })
				.where(eq(jobRunTable.id, open.id));
		}
		await db.insert(jobRunTable).values({ job: WORKER_JOB, detail: JSON.stringify(detail) });
	} catch (e) {
		console.warn('[job-log] worker progress failed:', e);
	}
}

/** Latest live state of the portable API worker. */
export async function getWorkerStatus(): Promise<WorkerStatus> {
	try {
		const [row] = await db
			.select({ startedAt: jobRunTable.startedAt, detail: jobRunTable.detail })
			.from(jobRunTable)
			.where(eq(jobRunTable.job, WORKER_JOB))
			.orderBy(desc(jobRunTable.id))
			.limit(1);
		if (!row) return EMPTY_WORKER;
		const detail = parseWorkerDetail(row.detail);
		if (!detail || !row.startedAt) return EMPTY_WORKER;
		const elapsedSeconds = (Date.parse(detail.at) - Date.parse(row.startedAt)) / 1000;
		return {
			active: true,
			lastSeenAt: detail.at,
			startedAt: row.startedAt,
			processed: detail.processed,
			written: detail.written,
			failed: detail.failed,
			secondsPerTrack:
				detail.processed > 0 && elapsedSeconds > 0 ? elapsedSeconds / detail.processed : null
		};
	} catch {
		return EMPTY_WORKER;
	}
}

/** Latest finished run per job id. */
export async function getLastRuns(): Promise<Record<string, LastRun | null>> {
	const out: Record<string, LastRun | null> = {};
	for (const job of JOB_IDS) {
		try {
			const [row] = await db
				.select({
					ok: jobRunTable.ok,
					detail: jobRunTable.detail,
					finishedAt: jobRunTable.finishedAt
				})
				.from(jobRunTable)
				.where(eq(jobRunTable.job, job))
				.orderBy(desc(jobRunTable.id))
				.limit(1);
			out[job] = row
				? { ...row, source: sourceFromDetail(row.detail) }
				: { ok: null, detail: null, finishedAt: null, source: 'manual' };
		} catch {
			out[job] = null;
		}
	}
	return out;
}

/** Strip the source prefix so a job's own message reads cleanly. */
export function jobDetailMessage(detail: string | null): string | null {
	if (!detail) return null;
	return detail.replace(/^(Automatic|Manual) · /, '');
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
