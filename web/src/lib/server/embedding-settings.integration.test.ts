import { beforeEach, describe, expect, test } from 'bun:test';
import postgres from 'postgres';

// Run only against an explicitly supplied disposable, migrated database.
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

describe.skipIf(!url)('embedding settings and uploads (pgvector)', () => {
	const client = postgres(url!);
	beforeEach(async () => {
		await client`TRUNCATE track CASCADE`;
		await client`DELETE FROM embedding_space`;
		await client`UPDATE embedding_settings SET mode = 'medium', hop_seconds = 0.5, max_sample_seconds = 90, frontend = 'kapre' WHERE id = 1`;
		await client`INSERT INTO embedding_space (version, model, mean_embedding, track_count, hop_seconds, max_sample_seconds, frontend)
			VALUES (1, 'openl3-512', array_fill(0::real, ARRAY[512])::vector, 0, 0.5, 90, 'kapre')`;
		process.env.WORKER_TOKEN = 'integration-worker';
	});

	async function upload(uri: string, dimension: number, hopSeconds = 0.5) {
		await client`INSERT INTO track (uri, name, artist, album) VALUES (${uri}, 'Example', ARRAY['Someone'], 'Record')`;
		const embedding = Array.from({ length: 512 }, (_, i) => i === dimension ? 1 : 0);
		const { POST } = await import('../../routes/api/worker/embeddings/+server');
		return POST({ request: new Request('http://localhost/api/worker/embeddings', {
			method: 'POST', headers: { Authorization: 'Bearer integration-worker', 'Content-Type': 'application/json' },
			body: JSON.stringify({ recipe: { model: 'openl3-512', hopSeconds, maxSampleSeconds: 90, frontend: 'kapre' },
				embeddings: [{ uri, name: 'Example', artist: ['Someone'], album: 'Record', model: 'openl3-512', embedding }] })
		}) } as Parameters<typeof POST>[0]);
	}

	test('first uploads replace the provisional mean and re-center earlier rows', async () => {
		expect((await upload('library://track/1', 0)).status).toBe(200);
		const [provisional] = await client`SELECT track_count FROM embedding_space WHERE version = 1`;
		expect(provisional.track_count).toBe(0);
		expect((await upload('library://track/2', 1)).status).toBe(200);
		const [space] = await client`SELECT track_count, mean_embedding::text AS mean FROM embedding_space WHERE version = 1`;
		expect(space.track_count).toBe(2);
		expect(JSON.parse(space.mean).slice(0, 2)).toEqual([0.5, 0.5]);
		const rows = await client`SELECT embedding_centered::text AS centered FROM track ORDER BY uri`;
		expect(JSON.parse(rows[0].centered)[0]).toBeCloseTo(Math.SQRT1_2, 5);
		expect(JSON.parse(rows[0].centered)[1]).toBeCloseTo(-Math.SQRT1_2, 5);
		expect(JSON.parse(rows[1].centered)[0]).toBeCloseTo(-Math.SQRT1_2, 5);
	});

	test('populated recipe changes fail without changing settings or registry', async () => {
		await upload('library://track/1', 0);
		const { setEmbeddingSettings, getWorkerRecipe } = await import('./embedding-settings');
		await expect(setEmbeddingSettings({ mode: 'high', maxSampleSeconds: 100 })).rejects.toThrow('already has embeddings');
		expect(await getWorkerRecipe()).toMatchObject({ hopSeconds: 0.5, maxSampleSeconds: 90 });
		const [spaces] = await client`SELECT count(*)::int AS n FROM embedding_space`;
		expect(spaces.n).toBe(1);
		await expect(setEmbeddingSettings({ mode: 'medium', maxSampleSeconds: 90 })).resolves.toMatchObject({ mode: 'medium' });
	});

	test('empty libraries can atomically change and register their recipe', async () => {
		const { setEmbeddingSettings, getWorkerRecipe } = await import('./embedding-settings');
		await setEmbeddingSettings({ mode: 'high', maxSampleSeconds: 100 });
		expect(await getWorkerRecipe()).toMatchObject({ hopSeconds: 1, maxSampleSeconds: 100 });
		const spaces = await client`SELECT version FROM embedding_space WHERE hop_seconds = 1 AND max_sample_seconds = 100`;
		expect(spaces).toHaveLength(1);
	});

	test('a worker with a stale registered recipe cannot populate a changed library', async () => {
		const { setEmbeddingSettings } = await import('./embedding-settings');
		await setEmbeddingSettings({ mode: 'high', maxSampleSeconds: 90 });
		expect((await upload('library://track/1', 0)).status).toBe(409);
		const [track] = await client`SELECT embedding FROM track WHERE uri = 'library://track/1'`;
		expect(track.embedding).toBeNull();
	});

	test('repair finalizes an already populated provisional space', async () => {
		for (let dimension = 0; dimension < 2; dimension++) {
			const raw = JSON.stringify(Array.from({ length: 512 }, (_, i) => i === dimension ? 1 : 0));
			await client`INSERT INTO track (uri, name, artist, album, embedding, embedding_space_version)
				VALUES (${`library://track/${dimension}`}, 'Example', ARRAY['Someone'], 'Record', ${raw}::vector, 1)`;
		}
		const { getCenteredSpaceState, repairCenteredSpace } = await import('./centered-space');
		expect((await getCenteredSpaceState()).needsBackfill).toBe(true);
		expect(await repairCenteredSpace()).toMatchObject({ ok: true, rowsCentered: 2 });
		expect((await getCenteredSpaceState()).needsBackfill).toBe(false);
		expect(await repairCenteredSpace()).toMatchObject({ alreadyHealthy: true, rowsCentered: 0 });
	});

	test('concurrent uploads finalize one shared corpus without deadlocking', async () => {
		const responses = await Promise.all([upload('library://track/1', 0), upload('library://track/2', 1)]);
		expect(responses.map((response) => response.status)).toEqual([200, 200]);
		const [space] = await client`SELECT track_count, mean_embedding::text AS mean FROM embedding_space WHERE version = 1`;
		expect(space.track_count).toBe(2);
		expect(JSON.parse(space.mean).slice(0, 2)).toEqual([0.5, 0.5]);
	});
});
