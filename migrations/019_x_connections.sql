CREATE TABLE IF NOT EXISTS battlecity_x_connections (
  player_id TEXT PRIMARY KEY REFERENCES battlecity_players(id) ON DELETE CASCADE,
  x_user_id TEXT UNIQUE NOT NULL CHECK (x_user_id ~ '^[0-9]{1,20}$'),
  x_username TEXT NOT NULL CHECK (x_username ~ '^[A-Za-z0-9_]{1,15}$'),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  follows_battlecities BOOLEAN NOT NULL DEFAULT FALSE,
  followed_checked_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS battlecity_x_connections_follow_check_idx
  ON battlecity_x_connections (followed_checked_at);
