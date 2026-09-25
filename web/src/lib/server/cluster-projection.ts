import { sql } from 'drizzle-orm';
import { getActiveClusterMetadata } from '$lib/server/active-clusters';
import type {
	ClusterProjectionCentroid,
	ClusterProjectionCluster,
	ClusterProjectionData,
	ClusterProjectionPoint
} from '$lib/cluster-projection-types';
import { db } from './db';

const EMBEDDING_SPACE_VERSION = 1;
const SAMPLE_PER_CLUSTER = 60;
const CACHE_MS = 10 * 60 * 1000;
const PCA_COMPONENTS = 3;
const PCA_ITERATIONS = 18;

type ProjectionRow = {
	uri: string;
	name: string;
	artist: string[];
	album: string;
	cluster_id: number;
	embedding_centered: string;
};

type CountRow = {
	cluster_id: number;
	track_count: number;
};

type CentroidRow = {
	cluster_id: number;
	embedding: string;
};

type InternalPoint = ProjectionRow & { vector: Float32Array };
type InternalCentroid = CentroidRow & { vector: Float32Array };

let cached: { expiresAt: number; data: ClusterProjectionData } | null = null;

function parseVector(value: string): Float32Array {
	const parsed = JSON.parse(value) as number[];
	return Float32Array.from(parsed);
}

function percentileAbsolute(values: number[], percentile = 0.99): number {
	if (!values.length) return 1;
	const sorted = values.map(Math.abs).sort((a, b) => a - b);
	const value = sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile))];
	return value || 1;
}

function normalizeAxis(values: number[]): {
	coordinates: number[];
	center: number;
	scale: number;
} {
	const center = values.reduce((sum, value) => sum + value, 0) / values.length;
	const scale = percentileAbsolute(values.map((value) => value - center));
	return {
		coordinates: values.map((value) => (value - center) / scale),
		center,
		scale
	};
}

/** Deterministic PCA using power iteration over a centered sample matrix. */
function projectPca(points: InternalPoint[]): {
	coordinates: number[][];
	explainedVariance: number[];
	mean: Float64Array;
	components: Float64Array[];
	axes: { center: number; scale: number }[];
} {
	const count = points.length;
	const dimensions = points[0]?.vector.length ?? 0;
	if (!count || !dimensions) {
		return {
			coordinates: [],
			explainedVariance: [],
			mean: new Float64Array(),
			components: [],
			axes: []
		};
	}

	const mean = new Float64Array(dimensions);
	for (const point of points) {
		for (let j = 0; j < dimensions; j++) mean[j] += point.vector[j];
	}
	for (let j = 0; j < dimensions; j++) mean[j] /= count;

	const matrix = new Float32Array(count * dimensions);
	let totalVariance = 0;
	for (let i = 0; i < count; i++) {
		for (let j = 0; j < dimensions; j++) {
			const centered = points[i].vector[j] - mean[j];
			matrix[i * dimensions + j] = centered;
			totalVariance += centered * centered;
		}
	}
	totalVariance /= count;

	const components: Float64Array[] = [];
	const coordinateAxes: number[][] = [];
	const componentVariance: number[] = [];

	for (let component = 0; component < PCA_COMPONENTS; component++) {
		const vector = new Float64Array(dimensions);
		for (let j = 0; j < dimensions; j++) {
			vector[j] = Math.sin((component + 1) * (j + 1) * 12.9898) + Math.cos((j + 1) * 0.37);
		}

		let scores = new Float64Array(count);
		for (let iteration = 0; iteration < PCA_ITERATIONS; iteration++) {
			scores.fill(0);
			for (let i = 0; i < count; i++) {
				let score = 0;
				const offset = i * dimensions;
				for (let j = 0; j < dimensions; j++) score += matrix[offset + j] * vector[j];
				scores[i] = score;
			}

			const next = new Float64Array(dimensions);
			for (let i = 0; i < count; i++) {
				const offset = i * dimensions;
				const weight = scores[i] / count;
				for (let j = 0; j < dimensions; j++) next[j] += matrix[offset + j] * weight;
			}

			for (const previous of components) {
				let projection = 0;
				for (let j = 0; j < dimensions; j++) projection += next[j] * previous[j];
				for (let j = 0; j < dimensions; j++) next[j] -= projection * previous[j];
			}

			let norm = 0;
			for (let j = 0; j < dimensions; j++) norm += next[j] * next[j];
			norm = Math.sqrt(norm);
			if (!norm) break;
			for (let j = 0; j < dimensions; j++) next[j] /= norm;

			let delta = 0;
			for (let j = 0; j < dimensions; j++) delta += Math.abs(next[j] - vector[j]);
			vector.set(next);
			if (delta < 1e-7) break;
		}

		scores = new Float64Array(count);
		for (let i = 0; i < count; i++) {
			const offset = i * dimensions;
			for (let j = 0; j < dimensions; j++) scores[i] += matrix[offset + j] * vector[j];
		}

		let variance = 0;
		for (let i = 0; i < count; i++) variance += scores[i] * scores[i];
		variance /= count;

		for (let i = 0; i < count; i++) {
			const offset = i * dimensions;
			const score = scores[i];
			for (let j = 0; j < dimensions; j++) matrix[offset + j] -= score * vector[j];
		}

		components.push(vector);
		coordinateAxes.push(Array.from(scores));
		componentVariance.push(variance);
	}

	const normalizedAxes = coordinateAxes.map(normalizeAxis);
	return {
		coordinates: normalizedAxes.map((axis) => axis.coordinates),
		explainedVariance: componentVariance.map((variance) =>
			totalVariance ? Number((variance / totalVariance).toFixed(4)) : 0
		),
		mean,
		components,
		axes: normalizedAxes.map(({ center, scale }) => ({ center, scale }))
	};
}

async function buildProjection(): Promise<ClusterProjectionData> {
	const {
		ids: clusterIds,
		names: clusterNames,
		matches: clusterMatches,
		activeRun
	} = await getActiveClusterMetadata();
	const clusterIdSql = sql.join(clusterIds, sql`, `);

	const rows = (await db.execute(sql`
		WITH ranked AS (
			SELECT
				uri,
				name,
				artist,
				album,
				cluster_id,
				embedding_centered::text AS embedding_centered,
				row_number() OVER (
					PARTITION BY cluster_id
					ORDER BY md5(uri || ':cluster-atlas-v1')
				) AS sample_rank
			FROM track
			WHERE embedding_centered IS NOT NULL
				AND embedding_space_version = ${EMBEDDING_SPACE_VERSION}
				AND cluster_id IN (${clusterIdSql})
		)
		SELECT uri, name, artist, album, cluster_id, embedding_centered
		FROM ranked
		WHERE sample_rank <= ${SAMPLE_PER_CLUSTER}
		ORDER BY cluster_id, sample_rank
	`)) as unknown as ProjectionRow[];

	const counts = (await db.execute(sql`
		SELECT cluster_id, count(*)::int AS track_count
		FROM track
		WHERE embedding_centered IS NOT NULL
			AND embedding_space_version = ${EMBEDDING_SPACE_VERSION}
			AND cluster_id IN (${clusterIdSql})
		GROUP BY cluster_id
		ORDER BY cluster_id
	`)) as unknown as CountRow[];

	const centroidRows = (await db.execute(sql`
		SELECT cluster_id, embedding::text AS embedding
		FROM cluster_centroid
		WHERE embedding_space_version = ${EMBEDDING_SPACE_VERSION}
			AND cluster_id IN (${clusterIdSql})
		ORDER BY cluster_id
	`)) as unknown as CentroidRow[];

	const points: InternalPoint[] = rows.map((row) => ({
		...row,
		vector: parseVector(row.embedding_centered)
	}));
	const pca = projectPca(points);

	const projected: ClusterProjectionPoint[] = points.map((point, index) => ({
		uri: point.uri,
		name: point.name,
		artists: point.artist,
		album: point.album,
		clusterId: point.cluster_id,
		x: pca.coordinates[0]?.[index] ?? 0,
		y: pca.coordinates[1]?.[index] ?? 0,
		z: pca.coordinates[2]?.[index] ?? 0
	}));

	const dimensions = points[0]?.vector.length ?? 0;
	const internalCentroids = centroidRows.flatMap((row): InternalCentroid[] => {
		try {
			const vector = parseVector(row.embedding);
			return vector.length === dimensions ? [{ ...row, vector }] : [];
		} catch (error) {
			console.warn(`Skipping invalid centroid for cluster ${row.cluster_id}:`, error);
			return [];
		}
	});
	const centroids: ClusterProjectionCentroid[] = internalCentroids.map((centroid) => {
		const coordinates = pca.components.map((component, componentIndex) => {
			let score = 0;
			for (let dimension = 0; dimension < dimensions; dimension++) {
				score += (centroid.vector[dimension] - pca.mean[dimension]) * component[dimension];
			}
			const axis = pca.axes[componentIndex];
			return axis ? (score - axis.center) / axis.scale : 0;
		});
		return {
			clusterId: centroid.cluster_id,
			x: coordinates[0] ?? 0,
			y: coordinates[1] ?? 0,
			z: coordinates[2] ?? 0
		};
	});

	const sampledCounts = new Map<number, number>();
	for (const point of projected) {
		sampledCounts.set(point.clusterId, (sampledCounts.get(point.clusterId) ?? 0) + 1);
	}
	const clusters: ClusterProjectionCluster[] = counts.map((row) => {
		const match = clusterMatches[row.cluster_id];
		return {
			id: row.cluster_id,
			name: clusterNames[row.cluster_id] ?? `Cluster ${row.cluster_id}`,
			trackCount: row.track_count,
			sampleCount: sampledCounts.get(row.cluster_id) ?? 0,
			...(match
				? {
						legacyClusterId: match.legacyClusterId,
						legacyName: match.legacyName,
						matchConfidence: match.confidence
					}
				: {})
		};
	});

	return {
		generatedAt: new Date().toISOString(),
		...(activeRun
			? {
					activeRun: {
						id: activeRun.id,
						k: activeRun.k,
						trackCount: activeRun.trackCount ?? 0,
						status: activeRun.status
					}
				}
			: {}),
		projection: 'pca',
		dimensions: points[0]?.vector.length ?? 512,
		pointCount: projected.length,
		perCluster: SAMPLE_PER_CLUSTER,
		explainedVariance: pca.explainedVariance,
		clusters,
		centroids,
		points: projected
	};
}

export async function getClusterProjection(): Promise<ClusterProjectionData> {
	if (cached && cached.expiresAt > Date.now()) return cached.data;
	const data = await buildProjection();
	cached = { data, expiresAt: Date.now() + CACHE_MS };
	return data;
}
