import { sql } from 'drizzle-orm';
import { db } from './db';
import {
	getLastRuns,
	getWorkerStatus,
	jobDetailMessage,
	JOB_IDS,
	type WorkerStatus
} from './job-log';

type Row = Record<string, unknown>;

type QueryResult<T extends Row> = {
	rows: T[];
	error?: string;
};

export type EmbeddingCounts = {
	total: number;
	embedded: number;
	pending: number;
	skipped: number;
	centered: number;
	versioned: number;
	clustered: number;
	unclustered: number;
	lastUpdated: string | null;
};

export type EmbeddingJob = {
	id: number;
	job: string;
	state: 'complete' | 'incomplete' | 'failed' | 'unfinished' | 'unknown' | 'not-started';
	ok: boolean | null;
	startedAt: string | null;
	finishedAt: string | null;
	processed: number | null;
	failed: number | null;
	remaining: number | null;
	complete: boolean | null;
	cursor: string | null;
	lastBatchAt: string | null;
	lastError: string | null;
};

export type EmbeddingSpace = {
	version: number;
	model: string;
	trackCount: number;
	createdAt: string | null;
};

export type ClusterQuality = {
	clusterCount: number | null;
	minClusterSize: number | null;
	maxClusterSize: number | null;
	meanClusterSize: number | null;
	meanIntraSimilarity: number | null;
	inertia: number | null;
	silhouette: number | null;
	adjustedRandIndex: number | null;
};

export type UpkeepJob = {
	job: string;
	ok: boolean | null;
	detail: string | null;
	source: 'automatic' | 'manual';
	finishedAt: string | null;
};

export type PipelineStatus = {
	generatedAt: string;
	embedding: {
		counts: EmbeddingCounts;
		space: EmbeddingSpace | null;
		worker: WorkerStatus;
		activeJob: EmbeddingJob | null;
		jobs: EmbeddingJob[];
	};
	upkeep: UpkeepJob[];
	clusters: {
		clustered: number;
		unclustered: number;
		topClusters: Array<{ clusterId: number; trackCount: number }>;
	};
	errors: string[];
};

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

async function readRows<T extends Row>(query: unknown): Promise<QueryResult<T>> {
	try {
		const result = await db.execute(query as never);
		return { rows: (result as unknown as T[]) ?? [] };
	} catch (error) {
		return { rows: [], error: errorMessage(error) };
	}
}

function numberOrNull(value: unknown): number | null {
	if (value === null || value === undefined || value === '') return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function numberOrZero(value: unknown): number {
	return numberOrNull(value) ?? 0;
}

function booleanOrNull(value: unknown): boolean | null {
	if (value === null || value === undefined) return null;
	if (typeof value === 'boolean') return value;
	if (value === 1 || value === '1' || value === 't' || value === 'true') return true;
	if (value === 0 || value === '0' || value === 'f' || value === 'false') return false;
	return null;
}

function dateOrNull(value: unknown): string | null {
	if (value === null || value === undefined || value === '') return null;
	if (value instanceof Date) return value.toISOString();
	const text = String(value);
	return Number.isNaN(new Date(text).getTime()) ? null : new Date(text).toISOString();
}

function stringOrNull(value: unknown): string | null {
	return value === null || value === undefined ? null : String(value);
}

function objectValue(value: unknown): Record<string, unknown> {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value);
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: {};
		} catch {
			return {};
		}
	}
	return {};
}

function jobState(row: Row, detail: Record<string, unknown>): EmbeddingJob['state'] {
	const finishedAt = dateOrNull(row.finished_at);
	if (!finishedAt) return 'unfinished';
	if (booleanOrNull(row.ok) === true && detail.complete !== false) return 'complete';
	if (booleanOrNull(row.ok) === false) {
		const remaining = numberOrNull(detail.remaining);
		return remaining !== null && remaining > 0 ? 'incomplete' : 'failed';
	}
	return 'unknown';
}

function mapJob(row: Row): EmbeddingJob {
	const detail = objectValue(row.detail);
	return {
		id: numberOrZero(row.id),
		job: stringOrNull(row.job) ?? 'embedding-worker',
		state: jobState(row, detail),
		ok: booleanOrNull(row.ok),
		startedAt: dateOrNull(row.started_at),
		finishedAt: dateOrNull(row.finished_at),
		processed: numberOrNull(detail.processed),
		failed: numberOrNull(detail.failed),
		remaining: numberOrNull(detail.remaining),
		complete: booleanOrNull(detail.complete),
		cursor: stringOrNull(detail.cursor),
		lastBatchAt: dateOrNull(detail.last_batch_at ?? detail.checkpointed_at),
		lastError: stringOrNull(detail.last_error)
	};
}

function mapUpkeepJob(
	job: string,
	row: {
		ok: boolean | null;
		detail: string | null;
		finishedAt: string | null;
		source: 'automatic' | 'manual';
	} | null
): UpkeepJob {
	return {
		job,
		ok: row?.ok ?? null,
		detail: jobDetailMessage(row?.detail ?? null),
		source: row?.source ?? 'manual',
		finishedAt: row?.finishedAt ?? null
	};
}

function uniqueErrors(values: Array<string | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export async function getPipelineStatus(): Promise<PipelineStatus> {
	const [countsResult, spaceResult, jobsResult, topClustersResult] = await Promise.all([
		readRows<Row>(sql`
				SELECT
					count(*)::bigint AS total,
					count(*) FILTER (WHERE embedding IS NOT NULL)::bigint AS embedded,
					count(*) FILTER (WHERE embedding IS NULL AND COALESCE(skip, FALSE) = FALSE)::bigint AS pending,
					count(*) FILTER (WHERE COALESCE(skip, FALSE) = TRUE)::bigint AS skipped,
					count(*) FILTER (WHERE embedding_centered IS NOT NULL)::bigint AS centered,
					count(*) FILTER (WHERE embedding_space_version IS NOT NULL)::bigint AS versioned,
					count(*) FILTER (WHERE cluster_id >= 0)::bigint AS clustered,
					count(*) FILTER (WHERE cluster_id IS NULL OR cluster_id < 0)::bigint AS unclustered,
					max(updated_at) AS last_updated
				FROM track
			`),
		readRows<Row>(sql`
				SELECT version, model, track_count, created_at
				FROM embedding_space
				ORDER BY version DESC
				LIMIT 1
			`),
		readRows<Row>(sql`
				SELECT id, job, started_at, finished_at, ok, detail
				FROM job_run
				WHERE job ILIKE '%embedding%'
				ORDER BY id DESC
				LIMIT 8
			`),
		readRows<Row>(sql`
				SELECT cluster_id, count(*)::bigint AS track_count
				FROM track
				WHERE cluster_id >= 0
				GROUP BY cluster_id
				ORDER BY track_count DESC, cluster_id ASC
				LIMIT 8
			`)
	]);

	const counts = countsResult.rows[0] ?? {};
	const spaceRow = spaceResult.rows[0];
	const jobs = jobsResult.rows.map(mapJob);
	const [lastRuns, worker] = await Promise.all([getLastRuns(), getWorkerStatus()]);
	const upkeep = JOB_IDS.map((job) => mapUpkeepJob(job, lastRuns[job] ?? null));

	return {
		generatedAt: new Date().toISOString(),
		embedding: {
			counts: {
				total: numberOrZero(counts.total),
				embedded: numberOrZero(counts.embedded),
				pending: numberOrZero(counts.pending),
				skipped: numberOrZero(counts.skipped),
				centered: numberOrZero(counts.centered),
				versioned: numberOrZero(counts.versioned),
				clustered: numberOrZero(counts.clustered),
				unclustered: numberOrZero(counts.unclustered),
				lastUpdated: dateOrNull(counts.last_updated)
			},
			space: spaceRow
				? {
						version: numberOrZero(spaceRow.version),
						model: stringOrNull(spaceRow.model) ?? 'unknown',
						trackCount: numberOrZero(spaceRow.track_count),
						createdAt: dateOrNull(spaceRow.created_at)
					}
				: null,
			worker,
			activeJob: jobs[0] ?? null,
			jobs
		},
		upkeep,
		clusters: {
			clustered: numberOrZero(counts.clustered),
			unclustered: numberOrZero(counts.unclustered),
			topClusters: topClustersResult.rows.map((row) => ({
				clusterId: numberOrZero(row.cluster_id),
				trackCount: numberOrZero(row.track_count)
			}))
		},
		errors: uniqueErrors([
			countsResult.error && `embedding counts: ${countsResult.error}`,
			spaceResult.error && `embedding space: ${spaceResult.error}`,
			jobsResult.error && `embedding jobs: ${jobsResult.error}`,
			topClustersResult.error && `cluster distribution: ${topClustersResult.error}`
		])
	};
}
