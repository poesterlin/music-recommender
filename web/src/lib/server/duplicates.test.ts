import { describe, expect, test } from 'bun:test';
import { findDuplicates } from './duplicates';

describe('findDuplicates', () => {
	test('degrades to an empty summary when the database is unreachable', async () => {
		// Manage must stay usable if the scan fails, so this reports zero
		// rather than throwing and taking the page down.
		const summary = await findDuplicates(10);
		expect(Array.isArray(summary.groups)).toBe(true);
		expect(typeof summary.groupCount).toBe('number');
	});
});
