CREATE TABLE IF NOT EXISTS battlecity_discord_follow_rewards (
  player_id TEXT PRIMARY KEY REFERENCES battlecity_players(id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL UNIQUE CHECK (discord_user_id ~ '^[0-9]{16,22}$'),
  fuel_amount INTEGER NOT NULL CHECK (fuel_amount = 5),
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
