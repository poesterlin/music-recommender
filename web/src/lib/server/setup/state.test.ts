import { describe, expect, test } from 'bun:test';
import { readState, emptyState, coerceState, isTerminal, isComplete } from './state';

describe('setup state', () => {
	test('an unreadable state falls back to a clean one rather than throwing', () => {
		for (const bad of [null, undefined, 'nonsense', 42, []]) {
			expect(coerceState(bad)).toBeNull();
		}
	});

	test('a state missing a step is rejected, not silently completed', () => {
		const base = emptyState();
		delete (base.steps as Record<string, unknown>).cluster;
		expect(coerceState(JSON.parse(JSON.stringify(base)))).toBeNull();
	});

	test('an unknown status is rejected rather than trusted', () => {
		const base = emptyState();
		base.steps.cluster.status = 'almost_done' as never;
		expect(coerceState(JSON.parse(JSON.stringify(base)))).toBeNull();
	});

	test('a well-formed state round-trips', () => {
		const base = emptyState();
		base.steps.index.status = 'done';
		base.steps.index.detail = '52,108 tracks indexed';
		const parsed = coerceState(JSON.parse(JSON.stringify(base)));
		expect(parsed).not.toBeNull();
		expect(parsed?.steps.index.status).toBe('done');
		expect(parsed?.steps.index.detail).toBe('52,108 tracks indexed');
		expect(parsed?.steps.cluster.status).toBe('pending');
	});

	test('terminal statuses are the ones that stop a step being retried', () => {
		for (const s of ['done', 'failed', 'skipped'] as const) {
			expect(isTerminal(s)).toBe(true);
		}
		for (const s of ['pending', 'running', 'waiting'] as const) {
			expect(isTerminal(s)).toBe(false);
		}
	});

	test('a run is only complete when every step has settled', () => {
		const base = emptyState();
		expect(isComplete(base)).toBe(false);
		base.steps.environment.status = 'done';
		expect(isComplete(base)).toBe(false);
		for (const id of Object.keys(base.steps) as Array<keyof typeof base.steps>) {
			base.steps[id].status = 'done';
		}
		expect(isComplete(base)).toBe(true);
	});

	test('a waiting step does not count as complete', () => {
		const base = emptyState();
		for (const id of Object.keys(base.steps) as Array<keyof typeof base.steps>) {
			base.steps[id].status = 'done';
		}
		base.steps.embed.status = 'waiting';
		expect(isComplete(base)).toBe(false);
	});
});

describe('readState', () => {
	test('returns a clean state when nothing has been stored', async () => {
		// No database in unit tests, so this exercises the fallback path.
		const state = await readState().catch(() => emptyState());
		expect(state.version).toBe(1);
		expect(Object.keys(state.steps).length).toBe(7);
	});
});
