import { expect, mock, test } from 'bun:test';

let chunk = 0;
const runs: Array<{ ok: boolean; detail: string }> = [];
mock.module('../src/lib/server/db', () => ({
	db: {
		execute: async () => [{ n: 0 }],
		insert: () => ({
			values: () => ({
				onConflictDoUpdate: async () => {
					if (chunk++ === 0) throw new Error('write failed');
				}
			})
		})
	}
}));
mock.module('../src/lib/server/ma-library', () => ({
	imageProxyPath: () => null,
	scanLibrary: async (
		_options: unknown,
		onPage: (items: unknown[], offset: number) => Promise<void>
	) => {
		await onPage(
			Array.from({ length: 151 }, (_, id) => ({
				uri: `library://track/${id}`,
				name: `Track ${id}`
			})),
			0
		);
	}
}));
mock.module('../src/lib/server/job-log', () => ({
	recordJobRun: async (_job: string, ok: boolean, detail: string) => {
		runs.push({ ok, detail });
	}
}));
mock.module('../src/lib/server/sync-favourites', () => ({ syncFavorites: async () => 0 }));
const { indexLibrary } = await import('../src/lib/server/index-library');
const { runIndexLibrary } = await import('../src/lib/server/jobs');

test('failed chunks do not inflate successful import counts and later chunks continue', async () => {
	chunk = 0;
	expect(await indexLibrary()).toEqual({ fetched: 151, added: 1, existing: 0, failed: 150 });
});

test('partial imports fail the job and include successful progress and retry guidance', async () => {
	chunk = 0;
	const result = await runIndexLibrary('manual');
	expect(result.ok).toBe(false);
	expect(result.detail).toContain('1 new');
	expect(result.detail).toContain('150 tracks failed');
	expect(result.detail).toContain('retry indexing');
	expect(runs.at(-1)?.ok).toBe(false);
});
