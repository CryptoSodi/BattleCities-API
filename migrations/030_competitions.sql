CREATE TABLE IF NOT EXISTS battlecity_competition_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  settings JSONB NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS battlecity_season_passes (
  player_id TEXT NOT NULL REFERENCES battlecity_players(id) ON DELETE CASCADE,
  season_id TEXT NOT NULL REFERENCES battlecity_seasons(id),
  purchased_at TIMESTAMPTZ NOT NULL,
  eligible_from TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  payment_signature TEXT NOT NULL UNIQUE,
  PRIMARY KEY (player_id, season_id),
  CHECK (eligible_from <= purchased_at AND purchased_at < expires_at)
);

CREATE TABLE IF NOT EXISTS battlecity_ranking_periods (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('cycle', 'season')),
  scope TEXT NOT NULL CHECK (scope IN ('gaming', 'trading')),
  season_id TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  policy JSONB NOT NULL,
  rows_json JSONB,
  closed_at TIMESTAMPTZ,
  CHECK (starts_at < ends_at)
);
CREATE INDEX IF NOT EXISTS battlecity_ranking_periods_history_idx
  ON battlecity_ranking_periods (kind, scope, ends_at DESC);

CREATE TABLE IF NOT EXISTS battlecity_ranking_payouts (
  id TEXT PRIMARY KEY,
  period_id TEXT NOT NULL REFERENCES battlecity_ranking_periods(id),
  player_id TEXT NOT NULL,
  wallet_address TEXT,
  rank INTEGER NOT NULL CHECK (rank > 0),
  amount TEXT NOT NULL,
  token_config JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'wallet_required', 'prepared', 'paid', 'failed')),
  delivery JSONB,
  error TEXT,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (period_id, player_id)
);
CREATE INDEX IF NOT EXISTS battlecity_ranking_payouts_history_idx
  ON battlecity_ranking_payouts (player_id, created_at DESC);

CREATE TABLE IF NOT EXISTS battlecity_native_oauth (
  token_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('x', 'discord')),
  player_id TEXT NOT NULL REFERENCES battlecity_players(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'exchanging', 'completed', 'failed')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS battlecity_native_oauth_expiry_idx ON battlecity_native_oauth (expires_at);

ALTER TABLE battlecity_shop_payments DROP CONSTRAINT IF EXISTS battlecity_shop_payments_currency_check;
ALTER TABLE battlecity_shop_payments ADD CONSTRAINT battlecity_shop_payments_currency_check
  CHECK (currency IN ('sol', 'token', 'skr'));

ALTER TABLE battlecity_trading_volume ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE battlecity_trading_volume ADD COLUMN IF NOT EXISTS prize_eligible BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS battlecity_swap_executions (
  signature TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES battlecity_players(id),
  request_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Legacy metadata validation is insufficient to authorize real-money prizes.
CREATE TABLE IF NOT EXISTS battlecity_match_prize_reviews (
  result_id TEXT PRIMARY KEY REFERENCES battlecity_match_results(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  reviewer_id TEXT NOT NULL REFERENCES battlecity_players(id),
  reason TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
