import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');

const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
try {
	const [authTable] = await sql`
		SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'user') AS present
	`;
	if (!authTable.present) {
		throw new Error('The user table is missing; run the authentication migration first');
	}

	await sql.unsafe(`
		CREATE TABLE IF NOT EXISTS "api_key" (
			"id" text PRIMARY KEY NOT NULL,
			"user_id" text NOT NULL,
			"name" text NOT NULL,
			"scope" text NOT NULL,
			"key_prefix" text NOT NULL,
			"key_hash" text NOT NULL UNIQUE,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL,
			"last_used_at" timestamp with time zone,
			"expires_at" timestamp with time zone,
			"revoked_at" timestamp with time zone,
			CONSTRAINT "api_key_scope_check" CHECK ("scope" IN ('worker', 'playback'))
		)
	`);
	await sql.unsafe(`
		DO $$
		BEGIN
			IF NOT EXISTS (
				SELECT 1 FROM pg_constraint WHERE conname = 'api_key_user_id_fkey'
			) THEN
				ALTER TABLE "api_key"
					ADD CONSTRAINT "api_key_user_id_fkey"
					FOREIGN KEY ("user_id") REFERENCES "user"("id")
					ON DELETE CASCADE ON UPDATE CASCADE;
			END IF;
		END
		$$
	`);
	await sql.unsafe('CREATE INDEX IF NOT EXISTS "apiKeyUserIdx" ON "api_key" ("user_id")');
	console.log('User API-key schema is ready');
} finally {
	await sql.end();
}
