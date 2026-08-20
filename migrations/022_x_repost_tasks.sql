CREATE TABLE IF NOT EXISTS battlecity_x_repost_tasks (
  id TEXT PRIMARY KEY,
  post_id TEXT UNIQUE NOT NULL CHECK (post_id ~ '^[0-9]{1,20}$'),
  post_url TEXT NOT NULL,
  reward_fuel INTEGER NOT NULL DEFAULT 5 CHECK (reward_fuel = 5),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_player_id TEXT REFERENCES battlecity_players(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS battlecity_x_repost_one_active
  ON battlecity_x_repost_tasks ((active)) WHERE active;

CREATE TABLE IF NOT EXISTS battlecity_x_repost_claims (
  task_id TEXT NOT NULL REFERENCES battlecity_x_repost_tasks(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES battlecity_players(id) ON DELETE CASCADE,
  x_user_id TEXT NOT NULL CHECK (x_user_id ~ '^[0-9]{1,20}$'),
  fuel_amount INTEGER NOT NULL CHECK (fuel_amount = 5),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task_id, player_id)
);
