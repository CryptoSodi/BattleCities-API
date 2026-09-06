CREATE TABLE IF NOT EXISTS battlecity_batc_powerup_drops (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES battlecity_players(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  level_number INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ,
  delivery_signature TEXT,
  delivery_raw_transaction TEXT,
  delivery_blockhash TEXT,
  delivery_last_valid_block_height BIGINT,
  delivery_error TEXT,
  CONSTRAINT battlecity_batc_powerup_drop_request_unique
    UNIQUE (player_id, request_id),
  CONSTRAINT battlecity_batc_powerup_drop_amount_check
    CHECK (amount IN (0, 100, 200)),
  CONSTRAINT battlecity_batc_powerup_drop_status_check
    CHECK (status IN ('none', 'issued', 'delivering', 'delivered', 'failed'))
);

CREATE INDEX IF NOT EXISTS battlecity_batc_powerup_drops_player_created_idx
  ON battlecity_batc_powerup_drops (player_id, created_at DESC);

CREATE INDEX IF NOT EXISTS battlecity_batc_powerup_drops_status_created_idx
  ON battlecity_batc_powerup_drops (status, created_at DESC);
