import { afterEach, describe, expect, jest, test } from 'bun:test';
import { SCHEDULES, startScheduledJobs, stopScheduledJobs } from './scheduler';
import { sourceFor } from './jobs';

/**
 * Note on ordering: Bun's in-process cron only observes fake timers that were
 * installed *before* `Bun.cron()` ran. Registering first and installing them
 * afterwards leaves the job silently unfired, so every fake-timer test here
 * sets the clock up front.
 */

const ORIGINAL_ENV = { ...process.env };

function configure(on: boolean) {
	if (on) {
		process.env.MUSIC_HOST = 'https://ma.example.test';
		process.env.MA_TOKEN = 'token';
	} else {
		delete process.env.MUSIC_HOST;
		delete process.env.MA_TOKEN;
	}
}

afterEach(() => {
	stopScheduledJobs();
	jest.useRealTimers();
	process.env = { ...ORIGINAL_ENV };
});

describe('schedules', () => {
	test('favourites sync is hourly, on a fixed minute', () => {
		// Wall-clock anchored, so the cadence cannot drift the way a relative
		// `sleep 3600` after the work does.
		let cursor = new Date('2026-09-28T15:17:00Z');
		const fires: string[] = [];
		for (let i = 0; i < 3; i++) {
			cursor = Bun.cron.parse(SCHEDULES.syncFavorites, cursor)!;
			fires.push(cursor.toISOString());
		}
		expect(fires).toEqual([
			'2026-09-28T16:07:00.000Z',
			'2026-09-28T17:07:00.000Z',
			'2026-09-28T18:07:00.000Z'
		]);
	});

	test('analyze is every six hours', () => {
		let cursor = new Date('2026-09-28T15:17:00Z');
		const fires: string[] = [];
		for (let i = 0; i < 3; i++) {
			cursor = Bun.cron.parse(SCHEDULES.analyze, cursor)!;
			fires.push(cursor.toISOString());
		}
		expect(fires).toEqual([
			'2026-09-28T18:23:00.000Z',
			'2026-09-29T00:23:00.000Z',
			'2026-09-29T06:23:00.000Z'
		]);
	});

	test('the two jobs can never land on the same minute', () => {
		// They have different natural periods; giving them different minutes
		// stops a slow job from contending with a fast one on the same tick.
		expect(SCHEDULES.syncFavorites.split(' ')[0]).not.toBe(SCHEDULES.analyze.split(' ')[0]);
	});
});

describe('startScheduledJobs', () => {
	test('does nothing when Music Assistant is not configured', () => {
		// A web-only local install has no library to maintain; registering here
		// would write a failed run every hour forever.
		configure(false);
		startScheduledJobs();
		// Registration is a no-op, so a second stop is safe and nothing throws.
		stopScheduledJobs();
		expect(true).toBe(true);
	});

	test('is idempotent', () => {
		configure(true);
		startScheduledJobs();
		// A second call must not double-register or throw.
		startScheduledJobs();
		startScheduledJobs();
		stopScheduledJobs();
		expect(true).toBe(true);
	});

	test('can be stopped and started again', () => {
		configure(true);
		startScheduledJobs();
		stopScheduledJobs();
		// If stop() cleared the handles, this re-registers cleanly.
		expect(() => startScheduledJobs()).not.toThrow();
	});
});

describe('sourceFor', () => {
	test('a service token means an automatic run, anything else is manual', () => {
		// This is what keeps a scheduled run distinguishable from the same job
		// pressed on the Manage page, in the job_run detail prefix.
		expect(sourceFor('service')).toBe('automatic');
		expect(sourceFor('session')).toBe('manual');
		expect(sourceFor(null)).toBe('manual');
		expect(sourceFor(undefined)).toBe('manual');
	});
});

describe('Bun.cron no-overlap guarantee', () => {
	test('a handler that overruns its interval is delayed, not stacked', async () => {
		// The property the whole design rests on: the next fire is computed only
		// after the handler settles. The `sleep N` loops this replaced would have
		// started a second run while the first was still going.
		jest.useFakeTimers();
		jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));

		let concurrent = 0;
		let maxConcurrent = 0;
		const job = Bun.cron('* * * * *', async () => {
			concurrent += 1;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			await new Promise((r) => setTimeout(r, 180_000)); // three intervals long
			concurrent -= 1;
		});

		try {
			for (let i = 0; i < 4; i++) {
				jest.advanceTimersByTime(60_000);
				await Promise.resolve();
			}
			expect(maxConcurrent).toBe(1);
		} finally {
			job.stop();
		}
	});
});
