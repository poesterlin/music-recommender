import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

type CheckLevel = 'ok' | 'warn' | 'fail';
type Check = { level: CheckLevel; name: string; detail: string };
type Options = { json: boolean; strict: boolean; skipAudio: boolean };

const args = process.argv.slice(2);
const options: Options = {
	json: args.includes('--json'),
	strict: args.includes('--strict'),
	skipAudio: args.includes('--skip-audio')
};
const checks: Check[] = [];

function add(level: CheckLevel, name: string, detail: string): void {
	checks.push({ level, name, detail });
}

function libraryFiles(root: string, limit = 20_000): number {
	const supported = new Set(['.mp3', '.flac', '.wav', '.m4a', '.ogg']);
	let count = 0;
	const pending = [root];
	while (pending.length > 0 && count < limit) {
		const directory = pending.pop()!;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				pending.push(path);
			} else if (supported.has(entry.name.toLowerCase().slice(entry.name.lastIndexOf('.')))) {
				count += 1;
				if (count >= limit) break;
			}
		}
	}
	return count;
}

function required(name: string, value: string | undefined, hint: string): void {
	if (value?.trim()) add('ok', name, 'configured');
	else add('fail', name, hint);
}

async function main(): Promise<void> {
	required('DATABASE_URL', process.env.DATABASE_URL, 'copy .env.example to .env and set the PostgreSQL URL');
	required('DOMAIN', process.env.DOMAIN, 'set the public hostname used by Traefik');
	required('MUSIC_HOST', process.env.MUSIC_HOST, 'set the Music Assistant base URL');
	required('MA_TOKEN', process.env.MA_TOKEN, 'set the Music Assistant access token');
	required('HA_HOST', process.env.HA_HOST, 'set the Home Assistant base URL for library sync');
	required('TOKEN', process.env.TOKEN, 'set the Home Assistant long-lived access token');
	required('CONFIG_ID', process.env.CONFIG_ID, 'set the Music Assistant config entry id');

	const musicPath = process.env.MUSIC_LIBRARY_PATH ?? process.env.AUDIO_DIR ?? '/music';
	if (options.skipAudio) {
		add('warn', 'music library', 'check skipped');
	} else if (!existsSync(musicPath)) {
		add('fail', 'music library', `path does not exist: ${musicPath}`);
	} else {
		try {
			const count = libraryFiles(musicPath);
			add(count > 0 ? 'ok' : 'warn', 'music library', `${count}${count === 20_000 ? '+' : ''} supported files under ${musicPath}`);
		} catch (error) {
			add('fail', 'music library', `could not scan ${musicPath}: ${String(error)}`);
		}
	}

	if (!process.env.DATABASE_URL?.trim()) {
		return finish();
	}

	const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 5 });
	try {
		const [db] = await sql`SELECT current_database() AS name, version() AS version`;
		add('ok', 'database connection', `${db.name} reachable`);

		const [extension] = await sql`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS enabled`;
		if (extension.enabled) add('ok', 'pgvector', 'extension enabled');
		else add('fail', 'pgvector', 'the vector extension is not enabled');

		const tables = await sql`
			SELECT table_name
			FROM information_schema.tables
			WHERE table_schema = 'public'
				AND table_name IN ('track', 'job_run', 'embedding_space', 'cluster_run', 'cluster_centroid')
			ORDER BY table_name
		`;
		const tableNames = new Set(tables.map((row) => String(row['table_name'])));
		for (const table of ['track', 'job_run', 'embedding_space', 'cluster_run', 'cluster_centroid']) {
			if (tableNames.has(table)) add('ok', `table ${table}`, 'present');
			else add('fail', `table ${table}`, 'missing; run bun run db:migrate');
		}

		if (tableNames.has('track')) {
			const columns = await sql`
				SELECT column_name
				FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name = 'track'
			`;
			const names = new Set(columns.map((row) => String(row['column_name'])));
			for (const column of ['embedding', 'embedding_centered', 'embedding_space_version', 'cluster_id']) {
				if (names.has(column)) add('ok', `track.${column}`, 'present');
				else add('fail', `track.${column}`, 'missing; run the database migrations');
			}
			const [counts] = await sql`
				SELECT
					count(*)::int AS total,
					count(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded,
					count(*) FILTER (WHERE embedding IS NULL AND COALESCE(skip, FALSE) = FALSE)::int AS pending
				FROM track
			`;
			add('ok', 'embedding coverage', `${counts.embedded}/${counts.total} embedded; ${counts.pending} pending`);
		}
	} catch (error) {
		add('fail', 'database checks', String(error));
	} finally {
		await sql.end();
	}
	return finish();
}

function finish(): void {
	const failed = checks.some((check) => check.level === 'fail');
	const warned = checks.some((check) => check.level === 'warn');
	if (options.json) {
		console.log(JSON.stringify({ ok: !failed && (!options.strict || !warned), checks }, null, 2));
	} else {
		for (const check of checks) {
			const marker = check.level === 'ok' ? '✓' : check.level === 'warn' ? '!' : '✗';
			console.log(`${marker} ${check.name}: ${check.detail}`);
		}
		if (failed) console.error('\nPreflight failed. Fix the errors above before starting the stack.');
		else if (options.strict && warned) console.error('\nPreflight completed with warnings (strict mode).');
		else console.log('\nPreflight passed.');
	}
	process.exitCode = failed || (options.strict && warned) ? 1 : 0;
}

await main();
