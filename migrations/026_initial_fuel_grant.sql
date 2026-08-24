ALTER TABLE battlecity_economy_accounts
  ALTER COLUMN fuel_balance SET DEFAULT 5;

INSERT INTO battlecity_economy_accounts
  (player_id, provider, wallet_address, token_balance, sol_balance,
   fuel_balance, inventory_json, loadout_json, created_at, updated_at)
SELECT p.id, p.provider, p.wallet_address, 1000, 1.25, 5,
  '{}'::JSONB, '{}'::JSONB, NOW(), NOW()
FROM battlecity_players p
ON CONFLICT (player_id) DO UPDATE SET
  fuel_balance = battlecity_economy_accounts.fuel_balance + 5,
  updated_at = NOW();

INSERT INTO battlecity_ledger_entries
  (id, player_id, wallet_address, currency, amount, reason, source_type,
   source_id, season_id, phase_id, event_id, created_at)
SELECT 'initial-fuel-grant-' || p.id, p.id, p.wallet_address, 'fuel', 5,
  'initial-five-fuel-grant', 'system-grant', 'initial-five-fuel-grant-v1',
  NULL, NULL, NULL, NOW()
FROM battlecity_players p
ON CONFLICT (id) DO NOTHING;
