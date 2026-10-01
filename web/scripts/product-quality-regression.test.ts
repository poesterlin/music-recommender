import { beforeEach, expect, mock, test } from 'bun:test';

// Run separately: these mocks deliberately replace database and upstream services.
let saved = [2];
let schedules: Array<{
	id: number;
	name: string;
	startHour: number;
	endHour: number;
	clusterIds: number[];
	enabled: boolean;
}> = [];
let writeFails = false;
let writes = 0;
let scheduleWrites = 0;
const database = {
	execute: async () => [{ cluster_id: 2 }, { cluster_id: 8 }],
	select: () => ({
		from: (table: { kind: string }) =>
			table.kind === 'schedule'
				? Promise.resolve(schedules)
				: table.kind === 'state'
					? { where: async () => [{ value: JSON.stringify(saved) }] }
					: { innerJoin: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }
	}),
	insert: (table: { kind: string }) => ({
		values: (value: { value: string }) => {
			if (table.kind === 'schedule') scheduleWrites++;
			return {
				onConflictDoUpdate: async () => {
					writes++;
					if (writeFails) throw new Error('database unavailable');
					saved = JSON.parse(value.value);
				}
			};
		}
	})
};
mock.module('../src/lib/server/db', () => ({ db: database }));
mock.module('../src/lib/server/schema', () => ({
	vibeStateTable: { kind: 'state', key: 'key' },
	vibeScheduleTable: { kind: 'schedule', id: 'id' },
	trackTable: {},
	likedSongsTable: {}
}));
const store = await import('../src/lib/server/vibe-store');
mock.module('$lib/server/db', () => ({ db: database }));
mock.module('$lib/server/schema', () => ({ trackTable: {}, likedSongsTable: {} }));
mock.module('$lib/server/vibe-store', () => store);
mock.module('$lib/server/active-clusters', () => ({
	getActiveClusterMetadata: async () => ({ names: {} })
}));
mock.module('$lib/server/recomendation-engine', () => ({
	recommend: async () => [],
	validateTrackUris: async () => []
}));
mock.module('$lib/server/webhook', () => ({ playSongs: async () => {} }));
const { POST } = await import('../src/routes/api/play-vibe/+server');

beforeEach(() => {
	saved = [2];
	schedules = [];
	writeFails = false;
	writes = 0;
	scheduleWrites = 0;
});

test('a schedule remains active independently of saved manual picks', async () => {
	schedules = [
		{ id: 1, name: 'Evening', startHour: 18, endHour: 22, clusterIds: [8], enabled: true }
	];
	expect((await store.getActiveSchedule(new Date(2026, 9, 1, 19)))?.id).toBe(1);
	await store.setVibeClusterIds([2]);
	expect((await store.getActiveSchedule(new Date(2026, 9, 1, 19)))?.id).toBe(1);
});

test('startup respects a deliberately empty schedule list', async () => {
	await store.ensureVibeSeeded();
	await store.ensureVibeSeeded();
	expect(scheduleWrites).toBe(0);
	expect(schedules).toEqual([]);
});

test('failed persistence rejects instead of returning saved picks', async () => {
	writeFails = true;
	await expect(store.setVibeClusterIds([8])).rejects.toThrow('database unavailable');
	expect(saved).toEqual([2]);
});

async function post(body: unknown) {
	return POST({
		request: new Request('http://localhost/api/play-vibe', {
			method: 'POST',
			body: JSON.stringify(body)
		})
	} as Parameters<typeof POST>[0]);
}

test('playing a selection does not write picks even when playback fails', async () => {
	const response = await post({ clusterIds: [8] });
	expect(response.status).toBe(500);
	expect(writes).toBe(0);
	expect(saved).toEqual([2]);
});

test('only Save picks persists a selection and failed saves report failure', async () => {
	expect((await post({ clusterIds: [8], saveOnly: true })).status).toBe(200);
	expect(saved).toEqual([8]);
	writeFails = true;
	const response = await post({ clusterIds: [2], saveOnly: true });
	expect(response.status).toBe(500);
	expect((await response.json()).success).toBe(false);
	expect(saved).toEqual([8]);
});
