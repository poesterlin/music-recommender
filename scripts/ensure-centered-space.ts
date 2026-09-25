import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	throw new Error("DATABASE_URL is not set");
}

const sql = postgres(databaseUrl, { max: 1 });

try {
	await sql.begin(async (tx) => {
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

			INSERT INTO "embedding_space" ("version", "model", "mean_embedding", "track_count")
			SELECT 1, 'openl3-512', avg("embedding")::vector, count(*)::integer
			FROM "track"
			WHERE "embedding" IS NOT NULL
			HAVING count(*) >= 2
			ON CONFLICT ("version") DO NOTHING;

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
