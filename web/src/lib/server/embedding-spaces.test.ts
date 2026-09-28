import { describe, expect, test } from 'bun:test';
import {
	describeSpace,
	modeForHop,
	EMBEDDING_MODES,
	type EmbeddingSpaceUsage
} from './embedding-spaces';

const space = (over: Partial<EmbeddingSpaceUsage> = {}): EmbeddingSpaceUsage => ({
	version: 1,
	model: 'openl3-512',
	hopSeconds: 0.1,
	maxSampleSeconds: 60,
	mode: 'low',
	frontend: 'kapre',
	trackCount: 25910,
	createdAt: '2026-09-24T12:38:28.875Z',
	tracks: 37277,
	clustered: 36691,
	share: 1,
	...over
});

describe('modeForHop', () => {
	test('names the three worker presets', () => {
		expect(modeForHop(0.1)).toBe('low');
		expect(modeForHop(0.5)).toBe('medium');
		expect(modeForHop(1.0)).toBe('high');
	});

	test('refuses to round a custom hop to a preset', () => {
		// A library on hop 0.25 is not "low" in any useful sense, and reporting
		// it as such would hide that it differs from the shipped recipe.
		expect(modeForHop(0.25)).toBeNull();
		expect(modeForHop(0.2)).toBeNull();
		expect(modeForHop(2)).toBeNull();
	});

	test('handles an unrecorded hop', () => {
		expect(modeForHop(null)).toBeNull();
	});

	test('the presets are the measured ones', () => {
		expect(EMBEDDING_MODES).toEqual({ low: 0.1, medium: 0.5, high: 1.0 });
	});
});

describe('describeSpace', () => {
	test('leads with the mode, because that is what a person chose', () => {
		const line = describeSpace(space({ hopSeconds: 0.5, mode: 'medium' }));
		expect(line).toContain('mode=medium');
		expect(line).toContain('hop=0.5s');
		expect(line).toContain('max=60s');
		expect(line).toContain('37,277 tracks');
	});

	test('says custom for a hop with no preset name', () => {
		const line = describeSpace(space({ hopSeconds: 0.25, mode: null }));
		expect(line).toContain('mode=custom');
		expect(line).toContain('hop=0.25s');
	});

	test('says unknown rather than guessing when settings are missing', () => {
		const line = describeSpace(
			space({
				version: -1,
				model: '(unregistered)',
				hopSeconds: null,
				maxSampleSeconds: null,
				mode: null
			})
		);
		expect(line).toContain('hop=unknown');
		expect(line).toContain('max=unknown');
		expect(line).toContain('mode=custom');
	});

	test('distinguishes two spaces that differ only by mode', () => {
		const low = describeSpace(space({ version: 1, hopSeconds: 0.1, mode: 'low' }));
		const high = describeSpace(space({ version: 2, hopSeconds: 1, mode: 'high' }));
		expect(low).not.toBe(high);
		expect(high).toContain('v2');
		expect(high).toContain('mode=high');
	});

	test('defaults the frontend when it was never recorded', () => {
		expect(describeSpace(space({ frontend: null }))).toContain('frontend=kapre');
	});
});
