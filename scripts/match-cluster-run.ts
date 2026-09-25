import postgres from 'postgres';
import { CLUSTER_NAMES } from '../web/src/lib/clusters.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');

const requestedRunId = process.argv[2] ? Number(process.argv[2]) : null;
if (requestedRunId !== null && (!Number.isSafeInteger(requestedRunId) || requestedRunId < 1)) {
	throw new Error('usage: bun scripts/match-cluster-run.ts [run-id]');
}

const sql = postgres(databaseUrl, { max: 1 });

type RunRow = {
	status: string;
	mode: string;
	k: number;
	track_count: number;
	config: Record<string, unknown>;
};

type PairRow = {
	cluster_id: number;
	previous_cluster_id: number;
	overlap: number;
};

try {
	const runId =
		requestedRunId ??
		(await sql<{ id: number }[]>`
			SELECT id
			FROM cluster_run
			WHERE status = 'applied'
			ORDER BY applied_at DESC NULLS LAST, id DESC
			LIMIT 1
		`)[0]?.id;
	if (!runId) throw new Error('no applied cluster run found');
	const run = await sql<RunRow[]>`
		SELECT
			status,
			mode,
			(config->>'k')::integer AS k,
			track_count,
			config
		FROM cluster_run
		WHERE id = ${runId}
	`;
	const runRow = run[0];
	if (!runRow) throw new Error(`cluster run ${runId} does not exist`);
	if (runRow.status !== 'applied' || (runRow.mode !== 'benchmark' && runRow.mode !== 'split')) {
		throw new Error(`cluster run ${runId} is not an applied benchmark or split`);
	}
	if (!Number.isSafeInteger(runRow.k) || runRow.k < 1) {
		throw new Error(`cluster run ${runId} has invalid k`);
	}

	const parentRunId = Number(runRow.config.source_run_id ?? 0);
	const parentNames = new Map<number, string>();
	if (Number.isSafeInteger(parentRunId) && parentRunId > 0) {
		const parentRows = await sql<{ cluster_id: number; legacy_name: string }[]>`
			SELECT cluster_id, legacy_name
			FROM cluster_run_match
			WHERE run_id = ${parentRunId}
		`;
		for (const row of parentRows) parentNames.set(row.cluster_id, row.legacy_name);
	}
	const sourceClusterId = Number(runRow.config.source_cluster_id ?? -1);
	const newClusterId = Number(runRow.config.new_cluster_id ?? -1);
	const splitNames = new Map<number, string>();
	if (runRow.mode === 'split' && sourceClusterId >= 0 && newClusterId >= 0) {
		splitNames.set(sourceClusterId, 'Melodic Alternative & British Rock');
		splitNames.set(newClusterId, 'Anthemic Alternative & Stadium Rock');
	}

	const pairs = await sql<PairRow[]>`
		SELECT
			cluster_id,
			previous_cluster_id,
			count(*)::integer AS overlap
		FROM cluster_run_assignment
		WHERE run_id = ${runId}
			AND previous_cluster_id >= 0
		GROUP BY cluster_id, previous_cluster_id
	`;
	const newTotals = await sql<{ cluster_id: number; count: number }[]>`
		SELECT cluster_id, count(*)::integer AS count
		FROM cluster_run_assignment
		WHERE run_id = ${runId}
		GROUP BY cluster_id
	`;
	const legacyTotals = await sql<{ cluster_id: number; count: number }[]>`
		SELECT previous_cluster_id AS cluster_id, count(*)::integer AS count
		FROM cluster_run_assignment
		WHERE run_id = ${runId}
			AND previous_cluster_id >= 0
		GROUP BY previous_cluster_id
	`;

	const newCount = new Map(newTotals.map((row) => [row.cluster_id, row.count]));
	const oldCount = new Map(legacyTotals.map((row) => [row.cluster_id, row.count]));
	const byNew = new Map<number, PairRow[]>();
	for (const pair of pairs) {
		const list = byNew.get(pair.cluster_id) ?? [];
		list.push(pair);
		byNew.set(pair.cluster_id, list);
	}

	const matches = [];
	for (let clusterId = 0; clusterId < runRow.k; clusterId++) {
		const total = newCount.get(clusterId) ?? 0;
		if (!total) throw new Error(`cluster ${clusterId} has no assignment rows`);
		const ranked = (byNew.get(clusterId) ?? []).sort(
			(a, b) => b.overlap - a.overlap || a.previous_cluster_id - b.previous_cluster_id
		);
		const primary = ranked[0];
		if (!primary) throw new Error(`cluster ${clusterId} has no legacy overlap`);

		const legacyName =
			parentNames.get(primary.previous_cluster_id) ??
			CLUSTER_NAMES[primary.previous_cluster_id] ??
			`Legacy Cluster ${primary.previous_cluster_id}`;
		const secondary = ranked[1];
		const confidence = primary.overlap / total;
		const secondaryName = secondary
			? parentNames.get(secondary.previous_cluster_id) ??
				CLUSTER_NAMES[secondary.previous_cluster_id] ??
				`Legacy Cluster ${secondary.previous_cluster_id}`
			: '';
		const splitName = splitNames.get(clusterId);
		const splitLabel =
			primary.previous_cluster_id === sourceClusterId &&
			(clusterId === sourceClusterId || clusterId === newClusterId)
				? ` · split ${clusterId === sourceClusterId ? 'A' : 'B'}`
				: '';
		const baseName = splitName ?? legacyName;
		const displayName = splitName
			? `${splitName}${splitLabel} · old #${primary.previous_cluster_id} (${Math.round(confidence * 100)}%)`
			: secondary && confidence < 0.35
				? `${legacyName} / ${secondaryName} · old #${primary.previous_cluster_id} (${Math.round(confidence * 100)}%)`
				: `${legacyName} · old #${primary.previous_cluster_id} (${Math.round(confidence * 100)}%)`;
		const relatedLegacyIds = ranked
			.slice(1, 4)
			.filter((pair) => pair.overlap > 0)
			.map((pair) => pair.previous_cluster_id);

		matches.push({
			runId,
			clusterId,
			legacyClusterId: primary.previous_cluster_id,
			legacyName,
			displayName,
			overlapCount: primary.overlap,
			newClusterCount: total,
			legacyClusterCount: oldCount.get(primary.previous_cluster_id) ?? 0,
			confidence: Number(confidence.toFixed(6)),
			relatedLegacyIds
		});
	}

	await sql.begin(async (tx) => {
		await tx`DELETE FROM cluster_run_match WHERE run_id = ${runId}`;
		for (const match of matches) {
			await tx`
				INSERT INTO cluster_run_match (
					run_id,
					cluster_id,
					legacy_cluster_id,
					legacy_name,
					display_name,
					overlap_count,
					new_cluster_count,
					legacy_cluster_count,
					confidence,
					related_legacy_ids
				) VALUES (
					${match.runId},
					${match.clusterId},
					${match.legacyClusterId},
					${match.legacyName},
					${match.displayName},
					${match.overlapCount},
					${match.newClusterCount},
					${match.legacyClusterCount},
					${match.confidence},
					${match.relatedLegacyIds}
				)
			`;
		}
	});

	const averageConfidence =
		matches.reduce((sum, match) => sum + match.confidence, 0) / matches.length;
	const lowConfidence = matches.filter((match) => match.confidence < 0.35).length;
	console.log(
		`Matched ${matches.length} k=${runRow.k} clusters to the previous layout; ` +
			`average dominant-overlap confidence ${(averageConfidence * 100).toFixed(1)}%, ` +
			`${lowConfidence} mixed matches.`
	);
	for (const match of matches) {
		console.log(
			`#${match.clusterId}: ${match.displayName} ` +
				`(${match.overlapCount}/${match.newClusterCount} tracks)`
		);
	}
} finally {
	await sql.end();
}
