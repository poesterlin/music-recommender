-- Let a writer declare which embedding space its vectors belong to.
--
-- `embedding_space_for_settings` (0014) was added to resolve a space by the
-- recipe the worker is about to use, but nothing called it: the centring
-- trigger still did "latest wins". That is only correct while every embedding
-- in the system is produced by one recipe. The moment a worker embeds at a
-- different hop -- OpenL3 is frame-based, so the hop changes what the vector
-- averages over, not just how long it takes -- its vectors would be centred
-- against a mean they were never meant to share and stamped with a version that
-- does not describe them, with nothing to detect the mix.
--
-- So: a writer that knows its recipe sets `track.embedding_space_version`
-- itself, and the trigger centres against *that* space. A writer that does not
-- (every existing local-mode path, and any hand-written SQL) keeps the old
-- "latest wins" behaviour. This is additive; no existing write changes meaning.
--
-- The function is replaced rather than altered so the fallback path is
-- byte-for-byte what it was.
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

		-- A declared version is authoritative. If it names a space that no
		-- longer exists, fall through to "latest wins" rather than refusing the
		-- write: the vector is already good, and losing it would be worse.
		IF NEW.embedding_space_version IS NOT NULL THEN
			SELECT "mean_embedding", "version"
			INTO active_mean, active_version
			FROM "embedding_space"
			WHERE "version" = NEW.embedding_space_version;

			IF active_mean IS NOT NULL THEN
				NEW.embedding_centered := center_openl3_embedding(NEW.embedding, active_mean);
				RETURN NEW;
			END IF;
		END IF;

		SELECT "mean_embedding", "version"
		INTO active_mean, active_version
		FROM "embedding_space"
		ORDER BY "version" DESC
		LIMIT 1;

		IF active_mean IS NULL THEN
			-- Fresh installations may receive raw embeddings before the centered
			-- space exists. Keep the raw vector and let the explicit bootstrap
			-- populate derived columns later.
			NEW.embedding_centered := NULL;
			NEW.embedding_space_version := NULL;
			RETURN NEW;
		END IF;

		NEW.embedding_centered := center_openl3_embedding(NEW.embedding, active_mean);
		NEW.embedding_space_version := active_version;
		RETURN NEW;
	END;
$func$;
