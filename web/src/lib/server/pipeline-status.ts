import { sql } from 'drizzle-orm';
import { db } from './db';

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

export type ClusterRun = {
	id: number;
	status: string;
	mode: string;
	k: number | null;
	trackCount: number | null;
	dimensions: number | null;
	createdAt: string | null;
	completedAt: string | null;
	appliedAt: string | null;
	error: string | null;
	meanPairwiseAri: number | null;
	minPairwiseAri: number | null;
	bestRun: {
		seed: number | null;
		iterations: number | null;
		converged: boolean | null;
		trainingInertia: number | null;
		quality: ClusterQuality;
	} | null;
	pca: {
		applied: boolean | null;
		inputDimensions: number | null;
		outputDimensions: number | null;
		explainedVariance: number[];
	};
};

export type PipelineStatus = {
	generatedAt: string;
	embedding: {
		counts: EmbeddingCounts;
		space: EmbeddingSpace | null;
		activeJob: EmbeddingJob | null;
		jobs: EmbeddingJob[];
	};
	clustering: {
		activeRun: ClusterRun | null;
		latestRun: ClusterRun | null;
		runs: ClusterRun[];
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

function mapClusterRun(row: Row): ClusterRun {
	const report = objectValue(row.report);
	const config = objectValue(row.config);
	const runs = Array.isArray(report.runs) ? report.runs : [];
	const bestIndex = numberOrNull(report.best_run);
	const best = bestIndex === null ? undefined : runs[bestIndex];
	const bestRecord = best && typeof best === 'object' ? objectValue(best) : {};
	const metrics = objectValue(bestRecord.metrics);
	const pca = objectValue(report.pca);
	const bestQuality: ClusterQuality = {
		clusterCount: numberOrNull(metrics.cluster_count),
		minClusterSize: numberOrNull(metrics.min_cluster_size),
		maxClusterSize: numberOrNull(metrics.max_cluster_size),
		meanClusterSize: numberOrNull(metrics.mean_cluster_size),
		meanIntraSimilarity: numberOrNull(metrics.mean_intra_similarity),
		inertia: numberOrNull(metrics.inertia),
		silhouette: numberOrNull(metrics.silhouette),
		adjustedRandIndex: numberOrNull(bestRecord.adjusted_rand_index_vs_current)
	};

	return {
		id: numberOrZero(row.id),
		status: stringOrNull(row.status) ?? 'unknown',
		mode: stringOrNull(row.mode) ?? 'benchmark',
		k: numberOrNull(config.k),
		trackCount: numberOrNull(row.track_count),
		dimensions: numberOrNull(row.dimensions),
		createdAt: dateOrNull(row.created_at),
		completedAt: dateOrNull(row.completed_at),
		appliedAt: dateOrNull(row.applied_at),
		error: stringOrNull(row.error),
		meanPairwiseAri: numberOrNull(report.mean_pairwise_ari),
		minPairwiseAri: numberOrNull(report.min_pairwise_ari),
		bestRun: best
			? {
					seed: numberOrNull(bestRecord.seed),
					iterations: numberOrNull(bestRecord.iterations),
					converged: booleanOrNull(bestRecord.converged),
					trainingInertia: numberOrNull(bestRecord.training_inertia),
					quality: bestQuality
				}
			: null,
		pca: {
			applied: booleanOrNull(pca.applied),
			inputDimensions: numberOrNull(pca.input_dimensions),
			outputDimensions: numberOrNull(pca.output_dimensions),
			explainedVariance: Array.isArray(pca.explained_variance_ratio)
				? pca.explained_variance_ratio.map((value) => Number(value)).filter(Number.isFinite)
				: []
		}
	};
}

function uniqueErrors(values: Array<string | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export async function getPipelineStatus(): Promise<PipelineStatus> {
	const [countsResult, spaceResult, jobsResult, runsResult, activeResult, topClustersResult] =
		await Promise.all([
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
				SELECT
					id, status, mode, config, report, track_count, dimensions,
					created_at, completed_at, applied_at, error
				FROM cluster_run
				ORDER BY id DESC
				LIMIT 8
			`),
			readRows<Row>(sql`
				SELECT
					id, status, mode, config, report, track_count, dimensions,
					created_at, completed_at, applied_at, error
				FROM cluster_run
				WHERE status = 'applied'
				ORDER BY applied_at DESC NULLS LAST, id DESC
				LIMIT 1
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
	const runs = runsResult.rows.map(mapClusterRun);
	const activeRun = activeResult.rows[0] ? mapClusterRun(activeResult.rows[0]) : null;

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
			activeJob: jobs[0] ?? null,
			jobs
		},
		clustering: {
			activeRun,
			latestRun: runs[0] ?? null,
			runs,
			topClusters: topClustersResult.rows.map((row) => ({
				clusterId: numberOrZero(row.cluster_id),
				trackCount: numberOrZero(row.track_count)
			}))
		},
		errors: uniqueErrors([
			countsResult.error && `embedding counts: ${countsResult.error}`,
			spaceResult.error && `embedding space: ${spaceResult.error}`,
			jobsResult.error && `embedding jobs: ${jobsResult.error}`,
			runsResult.error && `clustering runs: ${runsResult.error}`,
			activeResult.error && `active clustering: ${activeResult.error}`,
			topClustersResult.error && `cluster distribution: ${topClustersResult.error}`
		])
	};
}
