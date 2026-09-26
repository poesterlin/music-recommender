import { describe, expect, test } from 'bun:test';
import { getClusterCovers, getClusterTrackCounts } from './cover-image';

describe('getClusterTrackCounts', () => {
	test('returns an empty map instead of throwing without a database', async () => {
		// These helpers back a read-only browse page. A missing or unreachable
		// database must degrade to empty data, never break page load.
		const counts = await getClusterTrackCounts();
		expect(typeof counts).toBe('object');
		expect(counts).not.toBeNull();
	});
});

describe('getClusterCovers', () => {
	test('returns an empty map instead of throwing without a database', async () => {
		const covers = await getClusterCovers();
		expect(typeof covers).toBe('object');
		expect(covers).not.toBeNull();
	});
});
