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
    -- Fresh installations may receive their first raw embeddings before the
    -- centered space is created. Keep the raw vector and let the explicit
    -- backfill populate the derived columns once a mean exists.
    NEW.embedding_centered := NULL;
    NEW.embedding_space_version := NULL;
    RETURN NEW;
  END IF;

  NEW.embedding_centered := center_openl3_embedding(NEW.embedding, active_mean);
  NEW.embedding_space_version := active_version;
  RETURN NEW;
END;
$$;
