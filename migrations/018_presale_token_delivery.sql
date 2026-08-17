ALTER TABLE battlecity_presale_allocations
  ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS delivery_transaction_signature TEXT,
  ADD COLUMN IF NOT EXISTS delivery_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delivery_failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS delivery_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivery_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivery_raw_transaction TEXT,
  ADD COLUMN IF NOT EXISTS delivery_blockhash TEXT,
  ADD COLUMN IF NOT EXISTS delivery_last_valid_block_height BIGINT;

ALTER TABLE battlecity_presale_allocations
  DROP CONSTRAINT IF EXISTS battlecity_presale_allocations_delivery_status_check;

ALTER TABLE battlecity_presale_allocations
  ADD CONSTRAINT battlecity_presale_allocations_delivery_status_check
  CHECK (delivery_status IN ('pending', 'sending', 'delivered', 'failed'));

ALTER TABLE battlecity_presale_allocations
  DROP CONSTRAINT IF EXISTS battlecity_presale_allocations_delivery_attempts_check;

ALTER TABLE battlecity_presale_allocations
  ADD CONSTRAINT battlecity_presale_allocations_delivery_attempts_check
  CHECK (delivery_attempts >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS battlecity_presale_allocations_delivery_signature_idx
  ON battlecity_presale_allocations (delivery_transaction_signature)
  WHERE delivery_transaction_signature IS NOT NULL;
