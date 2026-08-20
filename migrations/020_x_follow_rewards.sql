CREATE TABLE IF NOT EXISTS battlecity_x_follow_rewards (
  player_id TEXT PRIMARY KEY REFERENCES battlecity_players(id) ON DELETE CASCADE,
  x_user_id TEXT NOT NULL CHECK (x_user_id ~ '^[0-9]{1,20}$'),
  fuel_amount INTEGER NOT NULL CHECK (fuel_amount = 5),
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
