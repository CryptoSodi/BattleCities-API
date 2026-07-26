CREATE TABLE IF NOT EXISTS battlecity_players (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  wallet_address TEXT NULL UNIQUE,
  google_subject TEXT NULL UNIQUE,
  google_email TEXT NULL,
  google_name TEXT NULL,
  google_picture TEXT NULL,
  highscore_primary BIGINT NOT NULL DEFAULT 0,
  highscore_secondary BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS battlecity_sessions (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  player_id TEXT NULL,
  wallet_address TEXT NULL,
  google_subject TEXT NULL,
  google_email TEXT NULL,
  google_name TEXT NULL,
  google_picture TEXT NULL
);

CREATE TABLE IF NOT EXISTS battlecity_economy_accounts (
  player_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  wallet_address TEXT NULL UNIQUE,
  token_balance BIGINT NOT NULL,
  sol_balance NUMERIC(18,6) NOT NULL,
  fuel_balance INTEGER NOT NULL,
  inventory_json JSONB NOT NULL,
  loadout_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS battlecity_ledger_entries (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  wallet_address TEXT NULL,
  currency TEXT NOT NULL,
  amount NUMERIC(18,6) NOT NULL,
  reason TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NULL,
  season_id TEXT NULL,
  phase_id TEXT NULL,
  event_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS battlecity_seasons (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL,
  name TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  reward_pool TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS battlecity_match_results (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  wallet_address TEXT NULL,
  display_name TEXT NOT NULL,
  season_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  level_number INTEGER NOT NULL,
  score INTEGER NOT NULL,
  game_points INTEGER NOT NULL,
  won BOOLEAN NOT NULL,
  replay_id TEXT NULL,
  validation_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  provider TEXT NOT NULL DEFAULT 'wallet'
);

CREATE TABLE IF NOT EXISTS battlecity_leaderboard_rows (
  scope TEXT NOT NULL,
  season_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  wallet_address TEXT NULL,
  display_name TEXT NOT NULL,
  points BIGINT NOT NULL,
  perk_badges_json JSONB NOT NULL,
  snapshot_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope, season_id, rank)
);

CREATE TABLE IF NOT EXISTS battlecity_replays (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  level_number INTEGER NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  kills INTEGER NOT NULL DEFAULT 0,
  game_result TEXT NOT NULL DEFAULT 'loss',
  duration_ticks INTEGER NOT NULL DEFAULT 0,
  replay_blob_path TEXT NOT NULL,
  replay_blob_url TEXT NOT NULL,
  validation_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS battlecity_quest_progress (
  player_id TEXT NOT NULL,
  quest_id TEXT NOT NULL,
  value NUMERIC(18,2) NOT NULL,
  claimed_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (player_id, quest_id)
);

CREATE TABLE IF NOT EXISTS battlecity_event_currency_balances (
  player_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  display_name TEXT NOT NULL DEFAULT 'Player',
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (player_id, event_id, currency)
);

CREATE TABLE IF NOT EXISTS battlecity_airdrop_state (
  campaign_id TEXT PRIMARY KEY,
  state_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS battlecity_staking_state (
  id INTEGER PRIMARY KEY,
  state_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS battlecity_trading_volume (
  signature TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  wallet_address TEXT NULL,
  mint TEXT NOT NULL,
  trait TEXT NOT NULL,
  volume_usd NUMERIC(18,2) NOT NULL,
  swap_from_mint TEXT NOT NULL,
  swap_to_mint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS battlecity_webrtc_signals (
  match_id TEXT NOT NULL,
  player_index INTEGER NOT NULL,
  kind TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revision BIGSERIAL PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS battlecity_webrtc_observers (
  match_id TEXT NOT NULL,
  observer_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (match_id, observer_id)
);

CREATE TABLE IF NOT EXISTS battlecity_wallet_challenges (
  nonce TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ NULL
);

-- Compatibility upgrades for databases created by the former request-time
-- schema initializers.
ALTER TABLE battlecity_players
  ADD COLUMN IF NOT EXISTS highscore_primary BIGINT NOT NULL DEFAULT 0;
ALTER TABLE battlecity_players
  ADD COLUMN IF NOT EXISTS highscore_secondary BIGINT NOT NULL DEFAULT 0;
ALTER TABLE battlecity_sessions ADD COLUMN IF NOT EXISTS wallet_address TEXT NULL;
ALTER TABLE battlecity_sessions ADD COLUMN IF NOT EXISTS google_subject TEXT NULL;
ALTER TABLE battlecity_sessions ADD COLUMN IF NOT EXISTS google_email TEXT NULL;
ALTER TABLE battlecity_sessions ADD COLUMN IF NOT EXISTS google_name TEXT NULL;
ALTER TABLE battlecity_sessions ADD COLUMN IF NOT EXISTS google_picture TEXT NULL;
ALTER TABLE battlecity_match_results
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'wallet';
ALTER TABLE battlecity_replays ADD COLUMN IF NOT EXISTS score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE battlecity_replays ADD COLUMN IF NOT EXISTS kills INTEGER NOT NULL DEFAULT 0;
ALTER TABLE battlecity_replays ADD COLUMN IF NOT EXISTS game_result TEXT NOT NULL DEFAULT 'loss';
ALTER TABLE battlecity_replays ADD COLUMN IF NOT EXISTS duration_ticks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE battlecity_replays
  ADD COLUMN IF NOT EXISTS validation_status TEXT NOT NULL DEFAULT 'pending';
