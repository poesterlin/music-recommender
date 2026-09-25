CREATE OR REPLACE FUNCTION center_openl3_embedding(input vector, mean vector)
RETURNS vector
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
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
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sync_track_centered_embedding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
    RAISE EXCEPTION 'No embedding space is available to center track %', NEW.uri;
  END IF;

  NEW.embedding_centered := center_openl3_embedding(NEW.embedding, active_mean);
  NEW.embedding_space_version := active_version;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS track_centered_embedding_sync ON track;
--> statement-breakpoint
CREATE TRIGGER track_centered_embedding_sync
BEFORE INSERT OR UPDATE ON track
FOR EACH ROW
EXECUTE FUNCTION sync_track_centered_embedding();
