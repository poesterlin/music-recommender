import { describe, expect, test } from 'bun:test';
import { describeSpace, type EmbeddingSpaceUsage } from './embedding-spaces';

const space = (over: Partial<EmbeddingSpaceUsage> = {}): EmbeddingSpaceUsage => ({
	version: 1,
	model: 'openl3-512',
	hopSeconds: 0.1,
	maxSampleSeconds: 60,
	frontend: 'kapre',
	trackCount: 25910,
	createdAt: '2026-09-24T12:38:28.875Z',
	tracks: 37277,
	clustered: 36691,
	share: 1,
	...over
});

describe('describeSpace', () => {
	test('reports the settings, because that is the whole point', () => {
		const line = describeSpace(space());
		expect(line).toContain('hop=0.1s');
		expect(line).toContain('max=60s');
		expect(line).toContain('frontend=kapre');
		expect(line).toContain('37,277 tracks');
		expect(line).toContain('100.0%');
	});

	test('makes a difference in hop visible rather than implied', () => {
		const a = describeSpace(space({ version: 1, hopSeconds: 0.1 }));
		const b = describeSpace(space({ version: 2, hopSeconds: 0.5 }));
		expect(a).not.toBe(b);
		expect(b).toContain('v2');
		expect(b).toContain('hop=0.5s');
	});

	test('says unknown rather than guessing when settings are missing', () => {
		// A row whose stamped version has no registry entry must not be
		// reported as if its settings were known.
		const line = describeSpace(
			space({ version: -1, model: '(unregistered)', hopSeconds: null, maxSampleSeconds: null })
		);
		expect(line).toContain('hop=unknown');
		expect(line).toContain('max=unknown');
	});

	test('defaults the frontend when it was never recorded', () => {
		expect(describeSpace(space({ frontend: null }))).toContain('frontend=kapre');
	});
});
