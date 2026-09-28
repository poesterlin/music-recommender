-- Record which embedding recipe produced each row.
--
-- `embedding_space` was already the recipe registry: it holds the corpus mean
-- and `track.embedding_space_version` stamps every row with the generation it
-- was centred against. What it did not record is *how* those embeddings were
-- produced, so two spaces with different settings were indistinguishable.
--
-- hop_seconds matters because OpenL3 is frame-based: at the shipped default of
-- 0.1s a 60s clip produces ~596 heavily-overlapping windows that are then mean
-- pooled, so the hop changes what the vector averages over and not just how long
-- it takes. max_sample_seconds records how much of the track was read.
--
-- Existing rows were all produced with the shipped defaults, so space 1 is
-- backfilled with those.
ALTER TABLE "embedding_space"
	ADD COLUMN IF NOT EXISTS "hop_seconds" real;
ALTER TABLE "embedding_space"
	ADD COLUMN IF NOT EXISTS "max_sample_seconds" real;
ALTER TABLE "embedding_space"
	ADD COLUMN IF NOT EXISTS "frontend" text;

-- 0.1 is OpenL3's own default and 60 is EMBEDDING_DURATION_SECONDS' default,
-- which is what every embedding written so far used.
UPDATE "embedding_space"
SET "hop_seconds" = 0.1,
	"max_sample_seconds" = 60,
	"frontend" = COALESCE("frontend", 'kapre')
WHERE "hop_seconds" IS NULL;

-- A space is identified by its settings, so the same recipe cannot be
-- registered twice under different versions.
CREATE UNIQUE INDEX IF NOT EXISTS "embedding_space_settings_idx"
	ON "embedding_space" (
		"model",
		"hop_seconds",
		"max_sample_seconds",
		"frontend"
	)
	WHERE "hop_seconds" IS NOT NULL AND "max_sample_seconds" IS NOT NULL;

-- Lets a space be selected by the recipe the worker is about to use, instead of
-- always taking the newest row. Rows with no settings yet keep the old
-- "latest wins" behaviour.
CREATE OR REPLACE FUNCTION embedding_space_for_settings(
	recipe_model text,
	recipe_hop real,
	recipe_max_seconds real,
	recipe_frontend text
)
RETURNS integer
LANGUAGE plpgsql
STABLE
AS $func$
DECLARE
	found integer;
BEGIN
	SELECT "version"
	INTO found
	FROM "embedding_space"
	WHERE "model" = recipe_model
		AND "hop_seconds" IS NOT DISTINCT FROM recipe_hop
		AND "max_sample_seconds" IS NOT DISTINCT FROM recipe_max_seconds
		AND COALESCE("frontend", 'kapre') = COALESCE(recipe_frontend, 'kapre')
	ORDER BY "version" DESC
	LIMIT 1;

	IF found IS NOT NULL THEN
		RETURN found;
	END IF;

	SELECT "version" INTO found
	FROM "embedding_space"
	ORDER BY "version" DESC
	LIMIT 1;

	RETURN found;
END;
$func$;

-- Fresh-install bootstrap (scripts/ensure-centered-space.ts) reads these.
-- Without defaults the column is nullable so a pre-0014 row is representable,
-- but a new space should always state its recipe.
COMMENT ON COLUMN "embedding_space"."hop_seconds" IS
	'OpenL3 window hop in seconds. Part of the recipe identity: it decides how many overlapping windows are mean pooled.';
COMMENT ON COLUMN "embedding_space"."max_sample_seconds" IS
	'Seconds of audio read per track. Part of the recipe identity.';
COMMENT ON COLUMN "embedding_space"."frontend" IS
	'OpenL3 frontend, e.g. kapre. Part of the recipe identity.';
