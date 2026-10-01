CREATE TABLE IF NOT EXISTS playback_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  player_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- No initial row: existing installations retain MA_PLAYER_NAME until a user
-- saves a selection. A saved NULL explicitly enables automatic player selection.
