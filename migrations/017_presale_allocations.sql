CREATE TABLE IF NOT EXISTS battlecity_presale_allocations (
  signature TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL UNIQUE,
  wallet_address TEXT NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('SOL')),
  payment_atomic NUMERIC(30, 0) NOT NULL,
  usd_micros NUMERIC(30, 0) NOT NULL,
  token_micros NUMERIC(30, 0) NOT NULL,
  stage_id SMALLINT NOT NULL CHECK (stage_id BETWEEN 1 AND 3),
  confirmed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS battlecity_presale_quotes (
  quote_id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  payment_atomic NUMERIC(30, 0) NOT NULL,
  usd_micros NUMERIC(30, 0) NOT NULL,
  token_micros NUMERIC(30, 0) NOT NULL,
  stage_id SMALLINT NOT NULL CHECK (stage_id BETWEEN 1 AND 3),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_signature TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS battlecity_presale_allocations_stage_id_idx
  ON battlecity_presale_allocations (stage_id);

CREATE INDEX IF NOT EXISTS battlecity_presale_allocations_wallet_address_idx
  ON battlecity_presale_allocations (wallet_address);

CREATE INDEX IF NOT EXISTS battlecity_presale_quotes_active_idx
  ON battlecity_presale_quotes (stage_id, expires_at)
  WHERE consumed_signature IS NULL;
