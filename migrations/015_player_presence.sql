CREATE TABLE IF NOT EXISTS battlecity_player_presence (
  player_id TEXT PRIMARY KEY REFERENCES battlecity_players(id) ON DELETE CASCADE,
  in_game BOOLEAN NOT NULL DEFAULT FALSE,
  game_mode TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT battlecity_player_presence_mode_check
    CHECK (game_mode IS NULL OR game_mode IN ('single-player', 'multiplayer'))
);

CREATE INDEX IF NOT EXISTS battlecity_player_presence_seen_idx
  ON battlecity_player_presence (last_seen_at DESC);
