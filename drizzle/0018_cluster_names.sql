CREATE TABLE cluster_name (
  id serial PRIMARY KEY,
  run_id integer NOT NULL,
  cluster_id integer NOT NULL,
  display_name text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'automatic')),
  UNIQUE (run_id, cluster_id)
);
--> statement-breakpoint
-- Preserve accepted names in every generation, including rollback targets.
-- Old rows cannot distinguish automatic from manual names; protect them as manual.
INSERT INTO cluster_name (run_id, cluster_id, display_name, source)
SELECT run_id, cluster_id, btrim(display_name), 'manual'
FROM cluster_run_match
WHERE btrim(display_name) <> ''
  AND display_name !~ ' · old #[0-9]+( \([0-9]+%\))?$';
