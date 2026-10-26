-- Start existing players' refill clock at rollout without granting extra fuel.
ALTER TABLE battlecity_economy_accounts
  ADD COLUMN fuel_refill_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
