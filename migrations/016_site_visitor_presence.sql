CREATE TABLE IF NOT EXISTS battlecity_site_presence (
  visitor_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  player_id TEXT REFERENCES battlecity_players(id) ON DELETE SET NULL,
  in_game BOOLEAN NOT NULL DEFAULT FALSE,
  game_mode TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (visitor_id, client_id),
  CONSTRAINT battlecity_site_presence_mode_check
    CHECK (game_mode IS NULL OR game_mode IN ('single-player', 'multiplayer'))
);

INSERT INTO battlecity_site_presence (
  visitor_id,
  client_id,
  player_id,
  in_game,
  game_mode,
  last_seen_at
)
SELECT
  'legacy-' || player_id,
  'legacy',
  player_id,
  in_game,
  game_mode,
  last_seen_at
FROM battlecity_player_presence
ON CONFLICT (visitor_id, client_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS battlecity_site_presence_last_seen_idx
  ON battlecity_site_presence (last_seen_at DESC);

DROP TABLE battlecity_player_presence;
