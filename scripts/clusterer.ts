import postgres from 'postgres';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

type CliValue = string | boolean;
type TrackRow = {
	uri: string;
	name: string;
	artist: string[];
	album: string;
	cluster_id: number | null;
	embedding: number[];
};

type WasmPayload = {
	report: Record<string, unknown>;
	labels: number[];
};

type RunnerOptions = {
	command: 'benchmark' | 'split';
	k: number;
	pcaDimensions: number;
	evaluationDimensions: number;
	pcaIterations: number;
	pcaSampleSize: number;
	runs: number;
	maxIterations: number;
	tolerance: number;
	seed: bigint;
	metricSampleSize: number;
	sample: number | null;
	threads: number | null;
	output: string | null;
	assignments: string | null;
	recordRun: boolean;
	splitClusterId: number | null;
	splitRuns: number;
	splitMaxIterations: number;
	splitTolerance: number;
	splitSeed: bigint;
	wasmPath: string;
	splitReport: string | null;
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');

function usage(): never {
	console.error(`Usage:
  bun scripts/clusterer.ts benchmark [options]
  bun scripts/clusterer.ts split --split-cluster-id ID --split-output FILE [options]

Benchmark options:
  --k N --pca-dim N --evaluation-dim N --pca-iterations N
  --pca-sample N --runs N --max-iterations N --tolerance N
  --seed N --metric-sample N --sample N --threads N
  --output FILE --assignments FILE --record-run --wasm FILE

Split options:
  --split-cluster-id ID --split-output FILE --split-report FILE
  --split-runs N --split-max-iterations N --split-tolerance N
  --split-seed N --record-run --wasm FILE

The Bun runner only computes and records artifacts. Use the native Rust
clusterer with --validate-apply and --confirm-apply for live changes.`);
	process.exit(2);
}

function parseCli(argv: string[]): RunnerOptions {
	const command = argv[0] === 'split' ? 'split' : argv[0] === 'benchmark' || !argv[0] ? 'benchmark' : usage();
	const values = new Map<string, CliValue>();
	for (let index = argv[0] === 'benchmark' || argv[0] === 'split' ? 1 : 0; index < argv.length; index++) {
		const token = argv[index];
		if (!token.startsWith('--')) usage();
		const key = token.slice(2);
		const next = argv[index + 1];
		if (next === undefined || next.startsWith('--')) values.set(key, true);
		else {
			values.set(key, next);
			index++;
		}
	}
	if (values.has('help')) usage();
	const number = (key: string, fallback: number): number => {
		const value = values.get(key);
		if (value === undefined) return fallback;
		const parsed = Number(value);
		if (!Number.isFinite(parsed)) throw new Error(`${key} must be numeric`);
		return parsed;
	};
	const integer = (key: string, fallback: number, minimum = 0): number => {
		const parsed = number(key, fallback);
		if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${key} must be an integer >= ${minimum}`);
		return parsed;
	};
	const seed = (key: string, fallback: number): bigint => {
		const value = values.get(key);
		if (value === undefined) return BigInt(fallback);
		try {
			return BigInt(String(value));
		} catch {
			throw new Error(`${key} must be an integer`);
		}
	};
	const text = (key: string): string | null => {
		const value = values.get(key);
		if (value === undefined || typeof value === 'boolean') return null;
		return value;
	};
	const threadsValue = values.has('threads') ? integer('threads', 1, 1) : null;
	return {
		command,
		k: integer('k', 50, 1),
		pcaDimensions: integer('pca-dim', 32, 0),
		evaluationDimensions: integer('evaluation-dim', 32, 0),
		pcaIterations: integer('pca-iterations', 10, 1),
		pcaSampleSize: integer('pca-sample', 5000, 1),
		runs: integer('runs', 3, 1),
		maxIterations: integer('max-iterations', 100, 1),
		tolerance: number('tolerance', 0.0001),
		seed: seed('seed', 42),
		metricSampleSize: integer('metric-sample', 1500, 1),
		sample: values.has('sample') ? integer('sample', 1, 1) : null,
		threads: threadsValue,
		output: text('output') ?? text('split-output'),
		assignments: text('assignments'),
		recordRun: values.get('record-run') === true,
		splitClusterId: values.has('split-cluster-id') ? integer('split-cluster-id', 0, 0) : null,
		splitRuns: integer('split-runs', 10, 1),
		splitMaxIterations: integer('split-max-iterations', 100, 1),
		splitTolerance: number('split-tolerance', 0.0001),
		splitSeed: seed('split-seed', 4242),
		wasmPath: text('wasm') ?? process.env.CLUSTER_WASM ?? resolve('clustering-wasm/target/wasm32-unknown-unknown/release/clustering_wasm.wasm'),
		splitReport: text('split-report')
	};
}

async function writeFile(path: string, contents: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await Bun.write(path, contents);
}

function jsonFile(contents: unknown): string {
	return `${JSON.stringify(contents, null, 2)}\n`;
}

async function loadTracks(sql: postgres.Sql, options: RunnerOptions): Promise<TrackRow[]> {
	const salt = `rust-cluster-bench:${options.seed}`;
	const rows = options.sample === null
		? await sql<TrackRow[]>`
			SELECT uri, name, artist, album, cluster_id, embedding_centered::real[] AS embedding
			FROM track
			WHERE embedding_centered IS NOT NULL AND embedding_space_version = 1
			ORDER BY uri
		`
		: await sql<TrackRow[]>`
			SELECT uri, name, artist, album, cluster_id, embedding_centered::real[] AS embedding
			FROM track
			WHERE embedding_centered IS NOT NULL AND embedding_space_version = 1
			ORDER BY md5(uri || ${salt})
			LIMIT ${options.sample}
		`;
	if (!rows.length) throw new Error('no embedded tracks found');
	const dimensions = rows[0].embedding.length;
	if (!dimensions || rows.some((row) => row.embedding.length !== dimensions || row.embedding.some((value) => !Number.isFinite(value)))) {
		throw new Error('embeddings have inconsistent dimensions or non-finite values');
	}
	return rows;
}

async function loadWasm(path: string): Promise<any> {
	const bytes = await Bun.file(path).arrayBuffer();
	const module = new WebAssembly.Module(bytes);
	const imports: Record<string, Record<string, (...args: any[]) => any>> = {};
	for (const item of WebAssembly.Module.imports(module)) {
		imports[item.module] ??= {};
		imports[item.module][item.name] = item.name.includes('throw')
			? () => {
					throw new Error('WASM runtime exception');
				}
			: () => undefined;
	}
	const instantiated: any = await WebAssembly.instantiate(module, imports);
	const exports = instantiated?.instance?.exports ?? instantiated?.exports;
	if (!exports) throw new Error('WASM instantiation returned no exports');
	for (const name of ['memory', 'wasm_alloc', 'wasm_free', 'run_benchmark']) {
		if (!(name in exports)) throw new Error(`WASM module is missing export: ${name}`);
	}
	return exports;
}

async function runWasm(
	wasm: any,
	rows: TrackRow[],
	options: {
		k: number;
		pcaDimensions: number;
		evaluationDimensions: number;
		pcaIterations: number;
		pcaSampleSize: number;
		runs: number;
		maxIterations: number;
		tolerance: number;
		seed: bigint;
		metricSampleSize: number;
	}
): Promise<WasmPayload> {
	const dimensions = rows[0]?.embedding.length ?? 0;
	const clusterValues = new Int32Array(rows.map((row) => row.cluster_id ?? -1));
	const inputBytes = rows.length * dimensions * Float32Array.BYTES_PER_ELEMENT;
	const clusterBytes = clusterValues.byteLength;
	const inputPtr = wasm.wasm_alloc(inputBytes);
	const clusterPtr = wasm.wasm_alloc(clusterBytes);
	const outputPtrPtr = wasm.wasm_alloc(8);
	if (!inputPtr || !clusterPtr || !outputPtrPtr) {
		if (inputPtr) wasm.wasm_free(inputPtr, inputBytes);
		if (clusterPtr) wasm.wasm_free(clusterPtr, clusterBytes);
		if (outputPtrPtr) wasm.wasm_free(outputPtrPtr, 8);
		throw new Error('WASM allocation failed');
	}
	let outputPtr = 0;
	let outputLength = 0;
	try {
		const inputView = new Float32Array(wasm.memory.buffer, inputPtr, rows.length * dimensions);
		for (let index = 0; index < rows.length; index++) {
			inputView.set(rows[index].embedding, index * dimensions);
			rows[index].embedding = [];
		}
		new Int32Array(wasm.memory.buffer, clusterPtr, clusterValues.length).set(clusterValues);
		const result = wasm.run_benchmark(
			inputPtr,
			clusterPtr,
			rows.length,
			dimensions,
			options.k,
			options.pcaDimensions,
			options.evaluationDimensions,
			options.pcaIterations,
			options.pcaSampleSize,
			options.runs,
			options.maxIterations,
			options.tolerance,
			options.seed,
			options.metricSampleSize,
			outputPtrPtr,
			outputPtrPtr + 4
		);
		const view = new DataView(wasm.memory.buffer);
		outputPtr = view.getUint32(outputPtrPtr, true);
		outputLength = view.getUint32(outputPtrPtr + 4, true);
		if (result !== 0 || !outputPtr || !outputLength) throw new Error(`WASM benchmark failed (${result})`);
		const output = new Uint8Array(wasm.memory.buffer, outputPtr, outputLength);
		const payload = JSON.parse(new TextDecoder().decode(output)) as WasmPayload;
		if (!payload || !Array.isArray(payload.labels) || !payload.report || payload.labels.length !== rows.length) {
			throw new Error('WASM returned an invalid payload');
		}
		return payload;
	} finally {
		if (outputPtr && outputLength) wasm.wasm_free(outputPtr, outputLength);
		wasm.wasm_free(inputPtr, inputBytes);
		wasm.wasm_free(clusterPtr, clusterBytes);
		wasm.wasm_free(outputPtrPtr, 8);
	}
}

function splitLabels(
	allRows: TrackRow[],
	splitRows: TrackRow[],
	splitClusterId: number,
	labels: number[],
	newClusterId: number
): number[] {
	const positions = new Map(splitRows.map((row, index) => [row.uri, index]));
	return allRows.map((row) => {
		if (row.cluster_id !== splitClusterId) return row.cluster_id ?? -1;
		const label = labels[positions.get(row.uri) ?? -1];
		return label === 0 ? splitClusterId : newClusterId;
	});
}

function orientSplitLabels(rows: TrackRow[], labels: number[]): number[] {
	const first = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
	for (let index = 0; index < rows.length; index++) {
		const label = labels[index];
		if (label === 0 || label === 1) first[label] = Math.min(first[label], rows[index].uri);
	}
	return first[1] < first[0] ? labels.map((label) => 1 - label) : labels;
}

async function recordRun(
	sql: postgres.Sql,
	mode: 'benchmark' | 'split',
	config: Record<string, unknown>,
	report: Record<string, unknown>,
	reportPath: string | null,
	assignmentsPath: string | null,
	trackCount: number,
	dimensions: number
): Promise<number> {
	const [row] = await sql<{ id: number }[]>`
		INSERT INTO cluster_run
			(status, mode, config, report, report_path, assignments_path, track_count, dimensions, completed_at)
		VALUES ('completed', ${mode}, ${JSON.stringify(config)}::text::jsonb,
			${JSON.stringify(report)}::text::jsonb, ${reportPath}, ${assignmentsPath}, ${trackCount}, ${dimensions}, now())
		RETURNING id
	`;
	return row.id;
}

const options = parseCli(process.argv.slice(2));
if (options.threads !== null) console.warn('--threads is ignored by the Bun/WASM engine; it is single-threaded.');
const sql = postgres(databaseUrl, { max: 1 });
try {
	if (options.command === 'split' && options.splitClusterId === null) usage();
	const loadStarted = performance.now();
	const allRows = await loadTracks(sql, options);
	console.log(`Loaded ${allRows.length} embedded tracks from PostgreSQL in ${(performance.now() - loadStarted).toFixed(0)}ms.`);
	const wasmStarted = performance.now();
	const wasm = await loadWasm(options.wasmPath);
	console.log(`Loaded Bun/WASM engine in ${(performance.now() - wasmStarted).toFixed(0)}ms.`);
	if (options.command === 'split') {
		if (!options.output) usage();
		const splitRows = allRows.filter((row) => row.cluster_id === options.splitClusterId);
		if (splitRows.length < 2) throw new Error(`cluster ${options.splitClusterId} has fewer than two tracks`);
		const splitStarted = performance.now();
		const splitResult = await runWasm(wasm, splitRows, {
			k: 2,
			pcaDimensions: 0,
			evaluationDimensions: 0,
			pcaIterations: 1,
			pcaSampleSize: splitRows.length,
			runs: options.splitRuns,
			maxIterations: options.splitMaxIterations,
			tolerance: options.splitTolerance,
			seed: options.splitSeed,
			metricSampleSize: Math.min(splitRows.length, 1500)
		});
		console.log(`Bun/WASM split completed in ${(performance.now() - splitStarted).toFixed(0)}ms.`);
		const labels = orientSplitLabels(splitRows, splitResult.labels);
		const currentMax = Math.max(...allRows.map((row) => row.cluster_id ?? -1));
		const newClusterId = currentMax + 1;
		const finalLabels = splitLabels(allRows, splitRows, options.splitClusterId, labels, newClusterId);
		const report = {
			kind: 'targeted_cluster_split',
			source_cluster_id: options.splitClusterId,
			new_cluster_id: newClusterId,
			final_k: newClusterId + 1,
			track_count: allRows.length,
			split_track_count: splitRows.length,
			subcluster_counts: {
				[String(options.splitClusterId)]: labels.filter((label) => label === 0).length,
				[String(newClusterId)]: labels.filter((label) => label === 1).length
			},
			seed: options.splitSeed.toString(),
			runs: options.splitRuns,
			best_run: splitResult.report.best_run,
			best_seed: splitResult.report.runs?.[splitResult.report.best_run as number]?.seed,
			iterations: splitResult.report.runs?.[splitResult.report.best_run as number]?.iterations,
			converged: splitResult.report.runs?.[splitResult.report.best_run as number]?.converged,
			inertia: splitResult.report.runs?.[splitResult.report.best_run as number]?.training_inertia
		};
		const reportPath = options.splitReport ?? `${options.output}.split-report.json`;
		const assignmentsPath = options.output;
		await writeFile(reportPath, jsonFile(report));
		await writeFile(assignmentsPath, `${allRows.map((row, index) => JSON.stringify({ uri: row.uri, name: row.name, clusterId: finalLabels[index] })).join('\n')}\n`);
		if (options.recordRun) {
			const [parent] = await sql<{ id: number }[]>`SELECT id FROM cluster_run WHERE status = 'applied' ORDER BY applied_at DESC NULLS LAST, id DESC LIMIT 1`;
			const config = { k: newClusterId + 1, mode: 'split', source_run_id: parent?.id ?? null, source_cluster_id: options.splitClusterId, new_cluster_id: newClusterId, split_runs: options.splitRuns, split_seed: options.splitSeed.toString(), split_max_iterations: options.splitMaxIterations, split_tolerance: options.splitTolerance };
			const runId = await recordRun(sql, 'split', config, report, reportPath, assignmentsPath, allRows.length, 512);
			console.log(`Recorded Bun split run #${runId}; artifacts: ${assignmentsPath}`);
			console.log(`Next: docker compose --profile clustering run --rm clusterer --apply-run-id ${runId} --apply-assignments ${assignmentsPath} --validate-apply`);
		} else {
			console.log(`Wrote Bun split artifacts: ${assignmentsPath}`);
		}
	} else {
		const benchmarkStarted = performance.now();
		const payload = await runWasm(wasm, allRows, options);
		console.log(`Bun/WASM benchmark completed in ${(performance.now() - benchmarkStarted).toFixed(0)}ms; peak RSS ${Math.round(process.memoryUsage.rss() / 1024 / 1024)}MB.`);
		const output = options.output ?? (options.recordRun ? `artifacts/cluster-run-${Date.now()}.json` : null);
		if (output) await writeFile(output, jsonFile(payload.report));
		if (options.assignments) {
			await writeFile(options.assignments, `${allRows.map((row, index) => JSON.stringify({ uri: row.uri, name: row.name, clusterId: payload.labels[index] })).join('\n')}\n`);
		}
		if (options.recordRun) {
			if (!output) throw new Error('--record-run requires --output or a generated report path');
			const runId = await recordRun(sql, 'benchmark', payload.report.config, payload.report, output, options.assignments, allRows.length, 512);
			console.log(`Recorded Bun benchmark run #${runId}; report: ${output}`);
			if (options.assignments) {
				console.log(`Next: docker compose --profile clustering run --rm clusterer --apply-run-id ${runId} --apply-assignments ${options.assignments} --validate-apply`);
			}
		} else if (!output) {
			console.log(JSON.stringify(payload.report, null, 2));
		} else {
			console.log(`Wrote Bun benchmark report: ${output}`);
		}
	}
} finally {
	await sql.end();
}
