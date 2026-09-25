import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');

const requestedRunId = process.argv[2] ? Number(process.argv[2]) : null;
if (requestedRunId !== null && (!Number.isSafeInteger(requestedRunId) || requestedRunId < 1)) {
	throw new Error('usage: bun scripts/name-split-clusters.ts [run-id]');
}

const sql = postgres(databaseUrl, { max: 1 });
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

	const names = [
		{ clusterId: 48, label: 'A', name: 'Melodic Alternative & British Rock' },
		{ clusterId: 50, label: 'B', name: 'Anthemic Alternative & Stadium Rock' }
	];

	await sql.begin(async (tx) => {
		for (const item of names) {
			const result = await tx`
				UPDATE cluster_run_match
				SET display_name = ${`${item.name} · split ${item.label} · old #48`}
				WHERE run_id = ${runId} AND cluster_id = ${item.clusterId}
			`;
			if (result.count !== 1) {
				throw new Error(`could not update cluster ${item.clusterId} in run ${runId}`);
			}
		}
	});

	console.log(`Named split clusters in run #${runId}:`);
	for (const item of names) {
		console.log(`#${item.clusterId}: ${item.name} · split ${item.label}`);
	}
} finally {
	await sql.end();
}
