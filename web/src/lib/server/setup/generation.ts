import { sql } from 'drizzle-orm';
import { db } from '../db';
import { clusterRunTable } from '../schema';
import type { KDerivation } from './derive-k';

export type Generation = {
	/** An applied cluster_run exists, so cluster ids and names are already live. */
	exists: boolean;
	runId: number | null;
	k: number | null;
	trackCount: number | null;
	/** Clusters in that generation with a manual or automatic name. */
	named: number;
};

/**
 * What generation, if any, is currently live.
 *
 * This is the guard that keeps first-run setup from destroying work. Renumbering
 * cluster ids while an applied run exists would leave every stored name pointing
 * at the wrong cluster, and the UI would confidently show the wrong labels.
 */
export async function inspectGeneration(): Promise<Generation> {
	const rows = (await db.execute(sql`
		SELECT id, (config->>'k')::integer AS k, track_count
		FROM cluster_run
		WHERE status = 'applied'
		ORDER BY applied_at DESC NULLS LAST, id DESC
		LIMIT 1
	`)) as unknown as Array<{ id: number; k: number | null; track_count: number | null }>;

	const run = rows[0];
	if (!run) {
		return { exists: false, runId: null, k: null, trackCount: null, named: 0 };
	}

	let named = 0;
	try {
		const namedRows = (await db.execute(sql`
			SELECT count(*)::int AS n FROM cluster_name
			WHERE run_id = ${run.id} AND NULLIF(BTRIM(display_name), '') IS NOT NULL
		`)) as unknown as Array<{ n: number }>;
		named = Number(namedRows[0]?.n ?? 0);
	} catch {
		// An older database may not have the dedicated name table yet.
	}

	return {
		exists: true,
		runId: run.id,
		k: run.k,
		trackCount: run.track_count,
		named
	};
}

/**
 * Record a freshly computed partition as the live generation.
 *
 * A new install has no run row, which would leave the cluster pages falling back
 * to the hardcoded CLUSTER_NAMES map — labels written against some other
 * library's numbering. Creating the run keeps a new install honest from the
 * first render; the naming step then fills the dedicated name table.
 */
export async function createGeneration(
	k: number,
	trackCount: number,
	derivation: KDerivation
): Promise<number> {
	const now = new Date().toISOString();
	const inserted = await db
		.insert(clusterRunTable)
		.values({
			status: 'applied',
			mode: 'setup',
			config: {
				k,
				track_count: trackCount,
				dimensions: 512,
				source: 'setup',
				// Keep the rule that produced this k auditable from the row alone.
				k_rule: '5*ln(N), capped at N/60 per cluster',
				k_explanation: derivation.explanation,
				k_capped_by_size: derivation.capped,
				log_k: derivation.logK
			},
			trackCount,
			dimensions: 512,
			appliedAt: now,
			completedAt: now
		})
		.returning({ id: clusterRunTable.id });

	const runId = inserted[0]?.id;
	if (runId === undefined) throw new Error('Could not record the cluster generation');

	return runId;
}

/** How many clusters in the live generation already carry a real label. */
export async function countNamedClusters(): Promise<number> {
	const generation = await inspectGeneration();
	if (!generation.exists || generation.runId === null) return 0;
	const rows = (await db.execute(sql`
		SELECT display_name FROM cluster_name WHERE run_id = ${generation.runId}
	`)) as unknown as Array<{ display_name: string | null }>;
	return rows.filter((row) => Boolean(row.display_name?.trim())).length;
}
