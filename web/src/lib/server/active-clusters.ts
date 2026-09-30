import { desc, eq, sql } from 'drizzle-orm';
import { CLUSTER_NAMES } from '$lib/clusters';
import { db } from './db';
import { clusterRunTable, clusterNameTable } from './schema';

export type ActiveClusterMetadata = {
	ids: number[];
	names: Record<number, string>;
	manualNameIds: number[];
	activeRun: {
		id: number;
		k: number;
		trackCount: number | null;
		status: string;
	} | null;
};

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
		.orderBy(sql`${clusterRunTable.appliedAt} DESC NULLS LAST`, desc(clusterRunTable.id))
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
			.orderBy(sql`${clusterRunTable.appliedAt} DESC NULLS LAST`, desc(clusterRunTable.id))
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

	const ids = activeRun
		? Array.from({ length: activeRun.k }, (_, id) => id)
		: Object.keys(CLUSTER_NAMES)
				.map(Number)
				.filter((id) => Number.isInteger(id))
				.sort((a, b) => a - b);
	const storedNames = activeRun
		? await db.select().from(clusterNameTable).where(eq(clusterNameTable.runId, activeRun.id))
		: [];
	const byId = new Map(storedNames.map((row) => [row.clusterId, row]));
	const names = Object.fromEntries(
		ids.map((id) => {
			const stored = byId.get(id)?.displayName.trim();
			if (stored) return [id, stored];
			if (activeRun) return [id, `Cluster ${id}`];
			return [id, CLUSTER_NAMES[id] ?? `Cluster ${id}`];
		})
	) as Record<number, string>;

	const manualNameIds = storedNames
		.filter((row) => row.source === 'manual' && row.displayName.trim())
		.map((row) => row.clusterId);
	return { ids, names, activeRun, manualNameIds };
}
