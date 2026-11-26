CREATE TABLE IF NOT EXISTS battlecity_shop_purchase_attempts (
  quote_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES battlecity_players(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  item_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_atomic NUMERIC(30,0) NOT NULL,
  token_decimals INTEGER NOT NULL,
  network TEXT NOT NULL,
  quote_token TEXT NOT NULL,
  signature TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','failed')),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_checked_at TIMESTAMPTZ,
  next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  check_count INTEGER NOT NULL DEFAULT 0,
  claim_id TEXT,
  claimed_until TIMESTAMPTZ,
  CONSTRAINT battlecity_shop_attempt_amount_positive CHECK (amount_atomic > 0)
);
CREATE INDEX IF NOT EXISTS battlecity_shop_attempt_pending_idx
  ON battlecity_shop_purchase_attempts (network, next_check_at, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS battlecity_shop_attempt_player_idx
  ON battlecity_shop_purchase_attempts (player_id, created_at DESC);
