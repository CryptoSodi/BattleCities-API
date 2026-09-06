CREATE TABLE IF NOT EXISTS battlecity_shop_payments (
  signature TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL UNIQUE,
  player_id TEXT NOT NULL REFERENCES battlecity_players(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  item_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_atomic NUMERIC(30,0) NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT battlecity_shop_payments_currency_check
    CHECK (currency IN ('sol', 'token')),
  CONSTRAINT battlecity_shop_payments_amount_check
    CHECK (amount_atomic > 0)
);

CREATE INDEX IF NOT EXISTS battlecity_shop_payments_player_idx
  ON battlecity_shop_payments (player_id, confirmed_at DESC);
