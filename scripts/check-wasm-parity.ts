import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const sample = '2000';
const args = [
	'--sample', sample,
	'--k', '20',
	'--pca-dim', '16',
	'--evaluation-dim', '16',
	'--runs', '3',
	'--max-iterations', '50',
	'--metric-sample', '500',
	'--seed', '42'
];

async function run(command: string[]): Promise<void> {
	const child = Bun.spawn(command, {
		cwd: root,
		env: process.env,
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited
	]);
	if (code !== 0) throw new Error(`${command.join(' ')} failed (${code})\n${stdout}\n${stderr}`);
}

async function readJson(path: string): Promise<any> {
	return JSON.parse(await readFile(path, 'utf8'));
}

async function readLabels(path: string): Promise<number[]> {
	return (await readFile(path, 'utf8'))
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line).clusterId as number);
}

function close(actual: number, expected: number, relative: number, absolute: number): boolean {
	return Math.abs(actual - expected) <= Math.max(absolute, Math.abs(expected) * relative);
}

function ari(left: number[], right: number[]): number {
	if (left.length !== right.length) throw new Error('label lengths differ');
	const choose2 = (value: number) => (value * (value - 1)) / 2;
	const leftCounts = new Map<number, number>();
	const rightCounts = new Map<number, number>();
	const pairs = new Map<string, number>();
	for (let index = 0; index < left.length; index++) {
		leftCounts.set(left[index], (leftCounts.get(left[index]) ?? 0) + 1);
		rightCounts.set(right[index], (rightCounts.get(right[index]) ?? 0) + 1);
		const key = `${left[index]}|${right[index]}`;
		pairs.set(key, (pairs.get(key) ?? 0) + 1);
	}
	const total = choose2(left.length);
	const sum = (counts: Map<number, number>) => [...counts.values()].reduce((acc, value) => acc + choose2(value), 0);
	const index = sum(leftCounts) * sum(rightCounts) / total;
	const agreement = [...pairs.values()].reduce((acc, value) => acc + choose2(value), 0);
	const expected = (sum(leftCounts) + sum(rightCounts)) / 2;
	return (agreement - index) / (expected - index);
}

const directory = await mkdtemp(join(tmpdir(), 'music-wasm-parity-'));
try {
	const bunReportA = join(directory, 'bun-a.json');
	const bunLabelsA = join(directory, 'bun-a.jsonl');
	const bunReportB = join(directory, 'bun-b.json');
	const bunLabelsB = join(directory, 'bun-b.jsonl');
	await run(['bun', 'scripts/clusterer.ts', 'benchmark', ...args, '--output', bunReportA, '--assignments', bunLabelsA]);
	await run(['bun', 'scripts/clusterer.ts', 'benchmark', ...args, '--output', bunReportB, '--assignments', bunLabelsB]);
	const firstReport = await readJson(bunReportA);
	const secondReport = await readJson(bunReportB);
	const firstLabels = await readLabels(bunLabelsA);
	const secondLabels = await readLabels(bunLabelsB);
	if (JSON.stringify(firstReport) !== JSON.stringify(secondReport) || JSON.stringify(firstLabels) !== JSON.stringify(secondLabels)) {
		throw new Error('Bun/WASM output is not deterministic across identical runs');
	}
	console.log('Bun/WASM repeatability: PASS');

	const nativeBinary = resolve(root, 'clustering-rs/target/release/cluster-bench');
	let nativeReport: any = null;
	let nativeLabels: number[] = [];
	try {
		const nativeOutput = join(directory, 'native.json');
		const nativeAssignments = join(directory, 'native.jsonl');
		await run([nativeBinary, ...args, '--output', nativeOutput, '--assignments', nativeAssignments]);
		nativeReport = await readJson(nativeOutput);
		nativeLabels = await readLabels(nativeAssignments);
	} catch (error) {
		if (process.env.SKIP_NATIVE_PARITY === '1') {
			console.warn(`Native comparison skipped: ${(error as Error).message.split('\n')[0]}`);
		} else {
			throw new Error(`Native comparison unavailable; build clustering-rs or set SKIP_NATIVE_PARITY=1: ${(error as Error).message}`);
		}
	}

	if (nativeReport) {
		if (nativeReport.config?.k !== firstReport.config?.k || nativeReport.track_count !== firstReport.track_count) {
			throw new Error('native/Bun report dimensions or k differ');
		}
		for (const field of ['mean_intra_similarity', 'inertia', 'silhouette']) {
			const expected = nativeReport.current_assignments?.[field];
			const actual = firstReport.current_assignments?.[field];
			if (typeof expected === 'number' && !close(actual, expected, 0.01, 0.01)) {
				throw new Error(`current ${field} differs too much: native=${expected} bun=${actual}`);
			}
		}
		for (let index = 0; index < nativeReport.runs.length; index++) {
			const expected = nativeReport.runs[index];
			const actual = firstReport.runs[index];
			for (const field of ['training_inertia']) {
				if (!close(actual[field], expected[field], 0.03, 0.5)) {
					throw new Error(`run ${index} ${field} differs too much: native=${expected[field]} bun=${actual[field]}`);
				}
			}
			for (const field of ['mean_intra_similarity', 'silhouette']) {
				if (!close(actual.metrics[field], expected.metrics[field], 0.03, 0.03)) {
					throw new Error(`run ${index} ${field} differs too much: native=${expected.metrics[field]} bun=${actual.metrics[field]}`);
				}
			}
		}
		const score = ari(nativeLabels, firstLabels);
		if (score < 0.4) throw new Error(`native/Bun partition ARI too low: ${score.toFixed(3)}`);
		console.log(`Native/Bun quality parity: PASS (partition ARI ${score.toFixed(3)})`);
	}
} finally {
	await rm(directory, { recursive: true, force: true });
}
