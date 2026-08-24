CREATE TABLE IF NOT EXISTS battlecity_push_devices (
  token TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES battlecity_players(id) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'android',
  permission_state TEXT NOT NULL DEFAULT 'unknown',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS battlecity_push_devices_player_id_idx
  ON battlecity_push_devices(player_id);
