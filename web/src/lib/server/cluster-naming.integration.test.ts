import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import postgres from 'postgres';

// Explicit disposable database only. Run after db:migrate.
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

describe.skipIf(!url)('cluster naming (PostgreSQL)', () => {
	const client = postgres(url!);
	beforeEach(async () => {
		await client`TRUNCATE track, cluster_name, cluster_run_match, cluster_run RESTART IDENTITY CASCADE`;
		await client`INSERT INTO cluster_run (status, mode, config, applied_at)
			VALUES ('applied', 'setup', '{"k":2}', now())`;
		await client`INSERT INTO track (uri, name, artist, album, cluster_id) VALUES
			('test:1', 'One', ARRAY['Sade'], 'Album', 0),
			('test:2', 'Two', ARRAY['Gorillaz'], 'Album', 0),
			('test:3', 'Three', ARRAY['Sade'], 'Album', 1)`;
	});
	afterAll(async () => {
		await client.end();
	});

	test('migration preserves accepted names across generations without accepting old-match suggestions', async () => {
		const migration = await Bun.file(
			new URL('../../../../drizzle/0018_cluster_names.sql', import.meta.url)
		).text();
		await client.begin(async (tx) => {
			await tx`CREATE SCHEMA name_migration_test`;
			await tx`SET LOCAL search_path TO name_migration_test`;
			await tx`CREATE TABLE cluster_run_match (run_id integer, cluster_id integer, display_name text)`;
			await tx`INSERT INTO cluster_run_match VALUES
				(1, 0, 'Original'), (2, 0, 'New name'), (2, 1, ''),
				(2, 2, 'Inherited · old #0 (100%)')`;
			for (const statement of migration.split('--> statement-breakpoint'))
				await tx.unsafe(statement);
			expect(
				await tx`SELECT run_id, display_name, source FROM cluster_name ORDER BY run_id`
			).toMatchObject([
				{ run_id: 1, display_name: 'Original', source: 'manual' },
				{ run_id: 2, display_name: 'New name', source: 'manual' }
			]);
			await tx`DROP SCHEMA name_migration_test CASCADE`;
		});
	});

	test('auto-names fresh clusters without match rows and is idempotent', async () => {
		const { applyAutoNames, suggestClusterNames } = await import('./cluster-naming');
		expect(await applyAutoNames([0, 1])).toBe(2);
		expect(await applyAutoNames([0, 1])).toBe(0);
		const names = await suggestClusterNames();
		expect(names[0]).toMatchObject({ name: 'Gorillaz, Sade', named: true });
		const { getActiveClusterMetadata } = await import('./active-clusters');
		const metadata = await getActiveClusterMetadata();
		expect(metadata.names[0]).toBe('Gorillaz, Sade');
		expect(metadata.manualNameIds).toEqual([]);
		expect(await client`SELECT * FROM cluster_run_match`).toHaveLength(0);
	});

	test('manual rename is protected, and reset permits auto-naming again', async () => {
		const { PUT } = await import('../../routes/api/clusters/[id]/name/+server');
		const { applyAutoNames } = await import('./cluster-naming');
		async function rename(name: string | null) {
			return PUT({
				params: { id: '0' },
				request: new Request('http://localhost/name', {
					method: 'PUT',
					body: JSON.stringify({ name })
				})
			} as Parameters<typeof PUT>[0]);
		}
		expect((await rename('Late night')).status).toBe(200);
		expect(await applyAutoNames([0])).toBe(0);
		const { getActiveClusterMetadata } = await import('./active-clusters');
		expect((await getActiveClusterMetadata()).manualNameIds).toEqual([0]);
		expect((await rename(null)).status).toBe(200);
		expect(await applyAutoNames([0])).toBe(1);
		expect((await getActiveClusterMetadata()).names[0]).toBe('Gorillaz, Sade');
	});

	test('generation switch and rollback select the corresponding names', async () => {
		await client`INSERT INTO cluster_name (run_id, cluster_id, display_name) VALUES (1, 0, 'Original')`;
		await client`UPDATE cluster_run SET status = 'superseded' WHERE id = 1`;
		await client`INSERT INTO cluster_run (status, mode, config, applied_at)
			VALUES ('applied', 'split', '{"k":2}', now())`;
		const { applyAutoNames } = await import('./cluster-naming');
		expect(await applyAutoNames([0])).toBe(1);
		const { getActiveClusterMetadata } = await import('./active-clusters');
		expect((await getActiveClusterMetadata()).names[0]).toBe('Gorillaz, Sade');
		await client`UPDATE cluster_run SET status = CASE WHEN id = 1 THEN 'applied' ELSE 'rolled_back' END`;
		expect((await getActiveClusterMetadata()).names[0]).toBe('Original');
	});
});
