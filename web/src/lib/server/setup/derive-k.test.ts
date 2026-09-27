import { describe, expect, test } from 'bun:test';
import {
	deriveClusterCount,
	LOG_COEFFICIENT,
	MAX_K,
	MIN_K,
	MIN_TRACKS_PER_CLUSTER
} from './derive-k';

describe('deriveClusterCount', () => {
	test('reproduces the running k=51 partition for this library', () => {
		// 26,144 clusterable tracks. The constant is pinned to this so a
		// first-run setup on this library does not silently renumber every
		// cluster and drop the names attached to them.
		const d = deriveClusterCount(26144);
		expect(d.k).toBe(51);
		expect(d.capped).toBe(false);
		expect(d.meanPerCluster).toBe(513);
	});

	test('grows logarithmically, not linearly', () => {
		// The whole point of the rule: 10x the library must not mean 10x the
		// vibes. Compare against the naive k = N / 500.
		const small = deriveClusterCount(3000).k;
		const large = deriveClusterCount(30000).k;
		expect(large / small).toBeLessThan(2);
		// A linear rule would give 60 here.
		expect(30000 / 500).toBe(60);
	});

	test('caps small libraries so clusters stay nameable', () => {
		// 5*ln(1000) = 34.5 -> 35, but that is 29 tracks per cluster, which is
		// too thin to name or sample from. The cap is what saves this case.
		const d = deriveClusterCount(1000);
		expect(d.logK).toBe(35);
		expect(d.capped).toBe(true);
		expect(d.k).toBe(Math.floor(1000 / MIN_TRACKS_PER_CLUSTER));
		expect(d.meanPerCluster).toBeGreaterThanOrEqual(MIN_TRACKS_PER_CLUSTER);
	});

	test('never drops below the minimum cluster size once the log is not binding', () => {
		for (const n of [1, 2, 10, 100, 500, 1000, 2000, 5000, 26000, 200000]) {
			const d = deriveClusterCount(n);
			if (n < MIN_TRACKS_PER_CLUSTER * MIN_K) {
				// Too small to satisfy the cap at all; MIN_K wins.
				expect(d.k).toBe(MIN_K);
			} else {
				expect(d.meanPerCluster).toBeGreaterThanOrEqual(MIN_TRACKS_PER_CLUSTER);
			}
		}
	});

	test('handles the degenerate inputs without throwing', () => {
		for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			const d = deriveClusterCount(bad);
			expect(d.k).toBe(0);
			expect(d.explanation).toContain('nothing to cluster');
		}
	});

	test('never returns a k above the sanity ceiling, for any input', () => {
		// MAX_K is defence-in-depth and is not reachable in practice: the size
		// cap only binds below ~24,000 tracks, and above that 5*ln(N) needs
		// N > e^80 to exceed 400. So this asserts the invariant holds rather
		// than that the clamp fires.
		for (const n of [1, 1000, 26144, 1e6, 1e12, Number.MAX_SAFE_INTEGER]) {
			expect(deriveClusterCount(n).k).toBeLessThanOrEqual(MAX_K);
		}
		// Growth really is that flat: a billion tracks only doubles k.
		expect(deriveClusterCount(1e6).k).toBeLessThan(deriveClusterCount(26144).k * 2);
	});

	test('is monotonic in library size', () => {
		// A bigger library must never produce fewer clusters, or re-running
		// setup after new music arrived would merge existing vibes.
		let previous = 0;
		for (const n of [500, 2000, 8000, 30000, 120000, 500000]) {
			const k = deriveClusterCount(n).k;
			expect(k).toBeGreaterThanOrEqual(previous);
			previous = k;
		}
	});

	test('the coefficient is the documented 5', () => {
		expect(LOG_COEFFICIENT).toBe(5);
	});
});
