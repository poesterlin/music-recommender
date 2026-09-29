import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	throw new Error("DATABASE_URL is not set");
}

const sql = postgres(databaseUrl, { max: 1 });

/**
 * Bump when the DDL below changes in a way that must be re-applied.
 *
 * This script duplicates drizzle/0004-0015 on purpose: a fresh install runs the
 * migrations, while every deploy runs only this. They therefore have to stay in
 * step, and a plain "IF NOT EXISTS" cannot notice a function body that drifted.
 * The marker is a comment inside each function body, so the preflight below can
 * compare it against what is live.
 *
 * Rev 2: the centring trigger honours a declared `embedding_space_version`
 *        (drizzle/0015). It had drifted back to "latest wins" here, so each
 *        deploy silently reverted the fix.
 */
const SCHEMA_REVISION = 2;

const REQUIRED_TABLES = [
	'embedding_space',
	'cluster_centroid',
	'cluster_run',
	'cluster_run_assignment',
	'cluster_centroid_backup',
	'cluster_run_match'
];
const REQUIRED_INDEXES = [
	'cluster_run_assignment_run_uri_idx',
	'cluster_centroid_backup_run_cluster_idx',
	'cluster_run_match_run_cluster_idx',
	'embeddingCenteredIndex'
];
const REQUIRED_COLUMNS = [
	['track', 'embedding_centered'],
	['track', 'embedding_space_version'],
	['cluster_centroid', 'embedding_space_version'],
	['cluster_run', 'applied_at'],
	['embedding_space', 'hop_seconds'],
	['embedding_space', 'max_sample_seconds'],
	['embedding_space', 'frontend']
] as const;
const REQUIRED_FUNCTIONS = [
	'center_openl3_embedding',
	'normalize_cluster_embedding',
	'sync_track_centered_embedding'
];

/**
 * Whether the schema already matches this revision.
 *
 * Every statement in the DDL block takes a strong lock *before* deciding it is a
 * no-op -- `CREATE TABLE IF NOT EXISTS` wants ACCESS EXCLUSIVE even when the
 * table is there -- so on an already-current database the whole block is pure
 * risk. One cheap read first means a routine deploy takes no locks at all and
 * cannot be blocked by a long-running query.
 */
async function isSchemaCurrent(): Promise<boolean> {
	const tables = await sql<{ name: string }[]>`
		SELECT c.relname AS name
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE c.relkind IN ('r', 'p')
			AND n.nspname = current_schema()
			AND c.relname IN ${sql(REQUIRED_TABLES)}
	`;
	const indexes = await sql<{ name: string }[]>`
		SELECT indexname AS name
		FROM pg_indexes
		WHERE schemaname = current_schema()
			AND indexname IN ${sql(REQUIRED_INDEXES)}
	`;
	// Compared as "table.column" so a single text array covers every pair.
	const columns = await sql<{ qualified: string }[]>`
		SELECT table_name || '.' || column_name AS qualified
		FROM information_schema.columns
		WHERE table_schema = current_schema()
			AND table_name || '.' || column_name IN ${sql(REQUIRED_COLUMNS.map(([table, column]) => `${table}.${column}`))}
	`;
	const functions = await sql<{ proname: string; prosrc: string }[]>`
		SELECT p.proname, p.prosrc
		FROM pg_proc p
		JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname = current_schema()
			AND p.proname IN ${sql(REQUIRED_FUNCTIONS)}
	`;

	if (tables.length !== REQUIRED_TABLES.length) return false;
	if (indexes.length !== REQUIRED_INDEXES.length) return false;
	if (columns.length !== REQUIRED_COLUMNS.length) return false;
	if (functions.length !== REQUIRED_FUNCTIONS.length) return false;

	const marker = `sole-schema: ${SCHEMA_REVISION}`;
	return functions.every((fn) => fn.prosrc.includes(marker));
}

async function applySchema(): Promise<boolean> {
	if (await isSchemaCurrent()) return false;

	await sql.begin(async (tx) => {
		// Fail fast rather than queue behind whatever holds the lock. Without
		// this a colliding read turns a deploy into a silent multi-minute stall.
		// LOCAL so it resets itself when the transaction ends.
		await tx.unsafe(`SET LOCAL lock_timeout = '10s'`);
		await tx.unsafe(`
			CREATE TABLE IF NOT EXISTS "embedding_space" (
				"version" integer PRIMARY KEY NOT NULL,
				"model" text NOT NULL,
				"mean_embedding" vector(512) NOT NULL,
				"track_count" integer NOT NULL,
				"created_at" timestamp DEFAULT now()
			);

			CREATE TABLE IF NOT EXISTS "cluster_centroid" (
				"cluster_id" integer PRIMARY KEY NOT NULL,
				"embedding" vector(512),
				"track_count" integer DEFAULT 0,
				"updated_at" timestamp DEFAULT now()
			);

			CREATE TABLE IF NOT EXISTS "cluster_run" (
				"id" serial PRIMARY KEY,
				"status" text NOT NULL DEFAULT 'completed',
				"mode" text NOT NULL DEFAULT 'benchmark',
				"config" jsonb NOT NULL,
				"report" jsonb,
				"report_path" text,
				"assignments_path" text,
				"track_count" integer,
				"dimensions" integer,
				"error" text,
				"created_at" timestamp NOT NULL DEFAULT now(),
				"completed_at" timestamp,
				"applied_at" timestamp
			);

			CREATE TABLE IF NOT EXISTS "cluster_run_assignment" (
				"id" serial PRIMARY KEY,
				"run_id" integer NOT NULL,
				"uri" text NOT NULL,
				"cluster_id" integer NOT NULL,
				"previous_cluster_id" integer,
				"created_at" timestamp NOT NULL DEFAULT now()
			);

			CREATE TABLE IF NOT EXISTS "cluster_centroid_backup" (
				"id" serial PRIMARY KEY,
				"run_id" integer NOT NULL,
				"cluster_id" integer NOT NULL,
				"embedding" vector(512),
				"track_count" integer,
				"embedding_space_version" integer,
				"created_at" timestamp NOT NULL DEFAULT now()
			);

			CREATE TABLE IF NOT EXISTS "cluster_run_match" (
				"id" serial PRIMARY KEY,
				"run_id" integer NOT NULL,
				"cluster_id" integer NOT NULL,
				"legacy_cluster_id" integer NOT NULL,
				"legacy_name" text NOT NULL,
				"display_name" text NOT NULL,
				"overlap_count" integer NOT NULL,
				"new_cluster_count" integer NOT NULL,
				"legacy_cluster_count" integer NOT NULL,
				"confidence" real NOT NULL,
				"related_legacy_ids" integer[] NOT NULL,
				"created_at" timestamp NOT NULL DEFAULT now()
			);

			CREATE UNIQUE INDEX IF NOT EXISTS "cluster_run_assignment_run_uri_idx"
				ON "cluster_run_assignment" ("run_id", "uri");
			CREATE UNIQUE INDEX IF NOT EXISTS "cluster_centroid_backup_run_cluster_idx"
				ON "cluster_centroid_backup" ("run_id", "cluster_id");
			CREATE UNIQUE INDEX IF NOT EXISTS "cluster_run_match_run_cluster_idx"
				ON "cluster_run_match" ("run_id", "cluster_id");

			ALTER TABLE "cluster_run"
				ADD COLUMN IF NOT EXISTS "applied_at" timestamp;

			ALTER TABLE "track"
				ADD COLUMN IF NOT EXISTS "embedding_centered" vector(512);
			ALTER TABLE "track"
				ADD COLUMN IF NOT EXISTS "embedding_space_version" integer;
			ALTER TABLE "cluster_centroid"
				ADD COLUMN IF NOT EXISTS "embedding_space_version" integer DEFAULT 1 NOT NULL;

			CREATE INDEX IF NOT EXISTS "embeddingCenteredIndex"
				ON "track" USING hnsw ("embedding_centered" vector_cosine_ops);

			CREATE OR REPLACE FUNCTION center_openl3_embedding(input vector, mean vector)
			RETURNS vector
			LANGUAGE plpgsql
			IMMUTABLE
			STRICT
			AS $func$
			-- sole-schema: 2
			DECLARE
				centered vector;
				norm double precision;
			BEGIN
				centered := input - mean;
				norm := sqrt(-(centered <#> centered));
				IF norm = 0 THEN
					RETURN NULL;
				END IF;

				RETURN array_to_vector(
					(
						ARRAY(
							SELECT value / norm
							FROM unnest(centered::real[]) AS value
						)
					)::real[],
					512,
					false
				);
			END;
			$func$;

			CREATE OR REPLACE FUNCTION normalize_cluster_embedding(input vector)
			RETURNS vector
			LANGUAGE plpgsql
			IMMUTABLE
			STRICT
			AS $func$
			-- sole-schema: 2
			DECLARE
				norm double precision;
			BEGIN
				norm := sqrt(-(input <#> input));
				IF norm = 0 THEN
					RETURN NULL;
				END IF;

				RETURN array_to_vector(
					(
						ARRAY(
							SELECT value / norm
							FROM unnest(input::real[]) AS value
						)
					)::real[],
					512,
					false
				);
			END;
			$func$;

			-- A fresh install bootstraps space 1 with the shipped defaults, which is
			-- what the worker uses until EMBEDDING_HOP_SECONDS changes. The settings
			-- are part of the recipe's identity, so a later hop registers as its own
			-- version rather than overwriting this one.
			INSERT INTO "embedding_space"
				("version", "model", "mean_embedding", "track_count",
				 "hop_seconds", "max_sample_seconds", "frontend")
			SELECT 1, 'openl3-512', avg("embedding")::vector, count(*)::integer,
				0.1, 60, 'kapre'
			FROM "track"
			WHERE "embedding" IS NOT NULL
			HAVING count(*) >= 2
			ON CONFLICT ("version") DO NOTHING;

			-- Backfill settings on any space created before they were recorded. Every
			-- historical embedding used those defaults, so this holds for a library
			-- that has only ever used one recipe.
			UPDATE "embedding_space"
			SET "hop_seconds" = 0.1,
				"max_sample_seconds" = 60,
				"frontend" = COALESCE("frontend", 'kapre')
			WHERE "hop_seconds" IS NULL OR "max_sample_seconds" IS NULL;

			UPDATE "track"
			SET "embedding_centered" = center_openl3_embedding(
					"embedding",
					(SELECT "mean_embedding" FROM "embedding_space" WHERE "version" = 1)
				),
				"embedding_space_version" = 1,
				"updated_at" = now()
			WHERE "embedding" IS NOT NULL
				AND EXISTS (
					SELECT 1 FROM "embedding_space" WHERE "version" = 1
				)
				AND (
					"embedding_centered" IS NULL
					OR "embedding_space_version" IS DISTINCT FROM 1
				);

			CREATE OR REPLACE FUNCTION sync_track_centered_embedding()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $func$
			-- sole-schema: 2
			DECLARE
				active_mean vector;
				active_version integer;
			BEGIN
				IF NEW.embedding IS NULL THEN
					NEW.embedding_centered := NULL;
					NEW.embedding_space_version := NULL;
					RETURN NEW;
				END IF;

				IF TG_OP = 'UPDATE' AND NEW.embedding IS NOT DISTINCT FROM OLD.embedding THEN
					RETURN NEW;
				END IF;

				-- A writer that knows its recipe sets the version; centre against
				-- that. Everything else keeps the original "latest wins" behaviour.
				-- See drizzle/0015_embedding_space_recipe.sql.
				IF NEW.embedding_space_version IS NOT NULL THEN
					SELECT mean_embedding, version
					INTO active_mean, active_version
					FROM embedding_space
					WHERE version = NEW.embedding_space_version;

					IF active_mean IS NOT NULL THEN
						NEW.embedding_centered := center_openl3_embedding(NEW.embedding, active_mean);
						RETURN NEW;
					END IF;
				END IF;

				SELECT mean_embedding, version
				INTO active_mean, active_version
				FROM embedding_space
				ORDER BY version DESC
				LIMIT 1;

				IF active_mean IS NULL THEN
					-- Fresh installations may receive raw embeddings before
					-- the centered space exists. Keep the raw vector and let
					-- the explicit backfill populate derived columns later.
					NEW.embedding_centered := NULL;
					NEW.embedding_space_version := NULL;
					RETURN NEW;
				END IF;

				NEW.embedding_centered := center_openl3_embedding(NEW.embedding, active_mean);
				NEW.embedding_space_version := active_version;
				RETURN NEW;
			END;
			$func$;

			DROP TRIGGER IF EXISTS track_centered_embedding_sync ON "track";
			CREATE TRIGGER track_centered_embedding_sync
			BEFORE INSERT OR UPDATE ON "track"
			FOR EACH ROW
			EXECUTE FUNCTION sync_track_centered_embedding();
		`);
	});
	return true;
}

try {
	const changed = await applySchema();
	if (!changed) {
		console.log(
			`Centered space schema is already at revision ${SCHEMA_REVISION}; skipped.`
		);
	}

	const [summary] = await sql`
		SELECT
			count(*)::int AS total_embeddings,
			count("embedding_centered")::int AS centered_embeddings,
			count(*) FILTER (
				WHERE "embedding_centered" IS NULL
					OR "embedding_space_version" IS DISTINCT FROM 1
			)::int AS pending_embeddings
		FROM "track"
		WHERE "embedding" IS NOT NULL
	`;

	if (summary.total_embeddings === 0) {
		console.log('No raw embeddings yet; centered-space creation is deferred.');
	} else {
		console.log(
			`Centered space ready: ${summary.centered_embeddings}/${summary.total_embeddings} embeddings; ` +
				`${summary.pending_embeddings} pending.`
		);
		if (summary.pending_embeddings !== 0) {
			if (summary.total_embeddings < 2) {
				console.warn(
					'Centered space needs at least two raw embeddings; backfill deferred until more tracks are embedded.'
				);
			} else {
				throw new Error("centered embedding backfill did not complete");
			}
		}
	}
} finally {
	await sql.end();
}
