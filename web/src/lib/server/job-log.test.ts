import { describe, expect, test } from 'bun:test';
import { jobDetailMessage, type WorkerStatus } from './job-log';

describe('jobDetailMessage', () => {
	test('strips the source prefix from a scheduled run', () => {
		expect(jobDetailMessage('Automatic · 12 new tracks')).toBe('12 new tracks');
		expect(jobDetailMessage('Manual · 3 new tracks')).toBe('3 new tracks');
	});

	test('leaves a message with no prefix intact', () => {
		expect(jobDetailMessage('12 new tracks')).toBe('12 new tracks');
	});

	test('treats null and empty detail as absent', () => {
		expect(jobDetailMessage(null)).toBeNull();
		expect(jobDetailMessage('')).toBeNull();
	});
});

describe('WorkerStatus', () => {
	// The badge and the liveness card both key off these fields, so the
	// no-data case must be distinguishable from a zero-progress run.
	test('an unseen worker is inactive rather than zero-progress', () => {
		const worker: WorkerStatus = {
			active: false,
			lastSeenAt: null,
			startedAt: null,
			processed: 0,
			written: 0,
			failed: 0,
			secondsPerTrack: null
		};
		expect(worker.active).toBe(false);
		expect(worker.lastSeenAt).toBeNull();
		expect(worker.secondsPerTrack).toBeNull();
	});
});
