-- One row holding the embedding recipe the whole system agrees on.
--
-- The problem this solves: the worker's hop and sample length were defaults that
-- lived in two places -- the Python constants and DEFAULT_RECIPE in
-- centered-space.ts -- while the server resolved an upload's space by exact
-- match with no fallback. That is a good design for correctness (a mismatched
-- vector is never silently mixed into another space) but a poor one for
-- operability: change a default in one place and every upload starts returning
-- 409 until someone notices and registers the new recipe by hand.
--
-- So the recipe becomes stored state rather than a constant. The server reads it
-- when it creates a space, and it is handed to the worker so the worker cannot
-- declare something the server has not registered.
--
-- The row is seeded from the currently active embedding_space rather than from
-- the shipped default, so an existing install adopts the recipe its 37k-odd
-- existing vectors were actually produced with. Seeding from the new default
-- instead would misattribute every embedding already in the database.
CREATE TABLE IF NOT EXISTS embedding_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- 'low' | 'medium' | 'high'. Advisory: it names the preset that produced
  -- these numbers so the UI and the logs can say something meaningful. The
  -- authoritative values are the three columns below, so a hand-tuned hop does
  -- not need a preset added to keep working.
  mode text NOT NULL DEFAULT 'medium',
  hop_seconds real NOT NULL DEFAULT 0.5,
  max_sample_seconds real NOT NULL DEFAULT 90,
  frontend text NOT NULL DEFAULT 'kapre',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT embedding_settings_hop_positive CHECK (hop_seconds > 0),
  CONSTRAINT embedding_settings_sample_positive CHECK (max_sample_seconds > 0)
);

-- Seed from the active space so an upgraded database keeps describing itself
-- accurately. INSERT ... SELECT yields no row when there are no embeddings yet,
-- which is correct: there is nothing to inherit, and the defaults apply.
INSERT INTO embedding_settings (id, mode, hop_seconds, max_sample_seconds, frontend)
SELECT
  1,
  -- Inherited from the space rather than guessed. `mode` is advisory so 'medium'
  -- is a safe label for whatever hop the space carries.
  CASE s.hop_seconds WHEN 0.1::real THEN 'low' WHEN 0.5::real THEN 'medium' WHEN 1::real THEN 'high' ELSE 'custom' END,
  s.hop_seconds,
  s.max_sample_seconds,
  COALESCE(s.frontend, 'kapre')
FROM embedding_space s
WHERE s.hop_seconds IS NOT NULL
  AND s.max_sample_seconds IS NOT NULL
ORDER BY s.version DESC
LIMIT 1
ON CONFLICT (id) DO NOTHING;

-- Guarantee a row exists even on a database with no embeddings at all, where
-- the INSERT above matched nothing. The app treats a missing row as the
-- default, but writing it means /api/embedding-spaces has something to update.
INSERT INTO embedding_settings (id, mode, hop_seconds, max_sample_seconds, frontend)
VALUES (1, 'medium', 0.5, 90, 'kapre')
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE embedding_settings IS
  'The single embedding recipe the server and every worker agree on. Workers are handed these values rather than using their own defaults, because the server resolves uploads by exact match with no fallback.';
COMMENT ON COLUMN embedding_settings.mode IS
  'Advisory label for the preset that produced these numbers. The columns below are authoritative.';

-- Bootstrap a fresh deployment so its first upload has a registered recipe.
-- With no corpus yet, zero mean leaves vectors unchanged until centering runs.
INSERT INTO embedding_space (version, model, mean_embedding, track_count, hop_seconds, max_sample_seconds, frontend)
SELECT 1, 'openl3-512', array_fill(0::real, ARRAY[512])::vector, 0,
       hop_seconds, max_sample_seconds, frontend
FROM embedding_settings
WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM embedding_space);
