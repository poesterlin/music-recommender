import { sql } from 'drizzle-orm';
import { CLUSTER_NAMES } from '$lib/clusters';
import { db } from './db';

type ActiveRunRow = {
	id: number;
	k: number;
	track_count: number | null;
	status: string;
};

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

export async function getActiveClusterMetadata(): Promise<ActiveClusterMetadata> {
	let activeRun: ActiveClusterMetadata['activeRun'] = null;
	try {
		const rows = (await db.execute(sql`
			SELECT
				id,
				(config->>'k')::integer AS k,
				track_count,
				status
			FROM cluster_run
			WHERE status = 'applied'
			ORDER BY applied_at DESC NULLS LAST, id DESC
			LIMIT 1
		`)) as unknown as ActiveRunRow[];
		const row = rows[0];
		if (row?.k && row.k > 0) {
			activeRun = {
				id: row.id,
				k: row.k,
				trackCount: row.track_count,
				status: row.status
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
			const rows = (await db.execute(sql`
				SELECT
					cluster_id,
					legacy_cluster_id,
					legacy_name,
					display_name,
					confidence
				FROM cluster_run_match
				WHERE run_id = ${activeRun.id}
				ORDER BY cluster_id
			`)) as unknown as Array<{
				cluster_id: number;
				legacy_cluster_id: number;
				legacy_name: string;
				display_name: string;
				confidence: number;
			}>;
			for (const row of rows) {
				matches[row.cluster_id] = {
					clusterId: row.cluster_id,
					legacyClusterId: row.legacy_cluster_id,
					legacyName: row.legacy_name,
					displayName: row.display_name,
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
	const names = Object.fromEntries(
		ids.map((id) => [
			id,
			matches[id]?.displayName ??
				(activeRun ? `K${activeRun.k} Cluster ${id}` : (CLUSTER_NAMES[id] ?? `Cluster ${id}`))
		])
	) as Record<number, string>;

	return { ids, names, matches, activeRun };
}
