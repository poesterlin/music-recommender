import { asc, desc, eq, sql } from 'drizzle-orm';
import { CLUSTER_NAMES } from '$lib/clusters';
import { db } from './db';
import { clusterRunTable, clusterRunMatchTable } from './schema';

export type ActiveClusterMatch = {
	clusterId: number;
	legacyClusterId: number;
	legacyName: string;
	displayName: string;
	confidence: number;
};

export type ActiveClusterMetadata = {
	ids: number[];
	names: Record<number, string>;
	matches: Record<number, ActiveClusterMatch>;
	activeRun: {
		id: number;
		k: number;
		trackCount: number | null;
		status: string;
	} | null;
};

/**
 * True when a stored display_name was chosen by a person.
 *
 * A clustering run starts by carrying the previous generation's names forward
 * through the match script, which appends a provenance marker. Those are not
 * human labels and must not be presented as if they were — the numbering they
 * were written against can shift between runs. Anything carrying the marker,
 * or left blank as an explicit reset, is treated as unnamed.
 */
export function isHumanNamed(displayName: string | null | undefined): boolean {
	const value = (displayName ?? '').trim();
	if (!value) return false;
	return !/\s·\sold\s+#\d+(\s\(\d+%\))?$/.test(value);
}

/**
 * The run whose cluster ids and names are currently live, or null.
 *
 * "Latest applied run" was spelled out as its own query in three places, which
 * is three chances to order it slightly differently. `desc()` on a nullable
 * column also needs care: `applied_at DESC` alone would put a NULL first,
 * which is why the id is the tiebreaker rather than an afterthought.
 */
export async function getActiveRunId(): Promise<number | null> {
	const [row] = await db
		.select({ id: clusterRunTable.id })
		.from(clusterRunTable)
		.where(eq(clusterRunTable.status, 'applied'))
		.orderBy(desc(clusterRunTable.appliedAt), desc(clusterRunTable.id))
		.limit(1);
	return row?.id ?? null;
}

export async function getActiveClusterMetadata(): Promise<ActiveClusterMetadata> {
	let activeRun: ActiveClusterMetadata['activeRun'] = null;
	try {
		const [row] = await db
			.select({
				id: clusterRunTable.id,
				k: sql<number | null>`(cluster_run.config->>'k')::integer`,
				trackCount: clusterRunTable.trackCount
			})
			.from(clusterRunTable)
			.where(eq(clusterRunTable.status, 'applied'))
			.orderBy(desc(clusterRunTable.appliedAt), desc(clusterRunTable.id))
			.limit(1);
		if (row?.k && row.k > 0) {
			activeRun = {
				id: row.id,
				k: row.k,
				trackCount: row.trackCount,
				status: 'applied'
			};
		}
	} catch {
		// The centered-space guard and migrations create cluster_run before the
		// cluster-aware pages are normally served. Keep the legacy map as a
		// fallback while an older database is being prepared.
	}

	const matches: Record<number, ActiveClusterMatch> = {};
	if (activeRun) {
		try {
			const rows = await db
				.select({
					clusterId: clusterRunMatchTable.clusterId,
					legacyClusterId: clusterRunMatchTable.legacyClusterId,
					legacyName: clusterRunMatchTable.legacyName,
					displayName: clusterRunMatchTable.displayName,
					confidence: clusterRunMatchTable.confidence
				})
				.from(clusterRunMatchTable)
				.where(eq(clusterRunMatchTable.runId, activeRun.id))
				.orderBy(asc(clusterRunMatchTable.clusterId));
			for (const row of rows) {
				matches[row.clusterId] = {
					clusterId: row.clusterId,
					legacyClusterId: row.legacyClusterId,
					legacyName: row.legacyName,
					displayName: row.displayName,
					confidence: Number(row.confidence)
				};
			}
		} catch {
			// Matching metadata is additive; generic K50 labels remain safe.
		}
	}

	const ids = activeRun
		? Array.from({ length: activeRun.k }, (_, id) => id)
		: Object.keys(CLUSTER_NAMES)
				.map(Number)
				.filter((id) => Number.isInteger(id))
				.sort((a, b) => a - b);
	// A carried-over or blank name falls back to the generic label. The legacy
	// hand-written map is only correct for a pre-run generation whose numbering
	// it was written against; reusing it after a re-cluster silently mislabels
	// every cluster.
	const names = Object.fromEntries(
		ids.map((id) => {
			const stored = matches[id]?.displayName ?? '';
			if (isHumanNamed(stored)) return [id, stored.trim()];
			if (activeRun) return [id, `Cluster ${id}`];
			return [id, CLUSTER_NAMES[id] ?? `Cluster ${id}`];
		})
	) as Record<number, string>;

	return { ids, names, matches, activeRun };
}
