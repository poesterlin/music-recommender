import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');
if (process.env.FRESH_DATABASE !== '1') {
	throw new Error('Refusing to write: set FRESH_DATABASE=1 and use a disposable database');
}

const vector = (offset: number) => `[${Array.from({ length: 512 }, (_, index) => ((index + offset * 3) % 17) + 1).join(',')}]`;
const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
const uris = ['ci://track/1', 'ci://track/2'];
const [initial] = await sql`
	SELECT
		(SELECT count(*)::int FROM track) AS tracks,
		(SELECT count(*)::int FROM embedding_space) AS spaces
`;

if (initial.tracks !== 0 || initial.spaces !== 0) {
	await sql.end();
	throw new Error('Refusing to write: fresh-db smoke requires an empty, migrated database');
}

try {
	await sql.begin(async (tx) => {
		for (const [index, uri] of uris.entries()) {
			await tx`
				INSERT INTO track (uri, name, artist, album, embedding)
				VALUES (${uri}, ${`CI Track ${index + 1}`}, ARRAY['CI Artist'], 'CI Album', ${vector(index + 1)}::vector)
			`;
		}
	});

	const childEnv: Record<string, string | undefined> = {
		DATABASE_URL: databaseUrl,
		HOME: process.env.HOME,
		PATH: process.env.PATH
	};
	const child = Bun.spawnSync([process.execPath, 'scripts/ensure-centered-space.ts'], {
		env: childEnv,
		stdout: 'inherit',
		stderr: 'inherit'
	});
	if (child.exitCode !== 0) throw new Error('centering backfill failed');

	const [summary] = await sql`
		SELECT
			count(*)::int AS total,
			count(*) FILTER (WHERE embedding_centered IS NOT NULL)::int AS centered
		FROM track
		WHERE uri LIKE 'ci://track/%'
	`;
	if (summary.total !== 2 || summary.centered !== 2) {
		throw new Error(`unexpected fresh-db centering result: ${JSON.stringify(summary)}`);
	}
	console.log('fresh database migration/backfill smoke test passed');
} finally {
	await sql`DELETE FROM track WHERE uri LIKE 'ci://track/%'`.catch(() => undefined);
	await sql`DELETE FROM embedding_space WHERE version = 1`.catch(() => undefined);
	await sql.end();
}
