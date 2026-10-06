-- Retire Google login and restore server-owned guest identities.
-- NOT VALID keeps historical identities intact while enforcing new writes.
ALTER TABLE battlecity_players DROP CONSTRAINT IF EXISTS battlecity_provider_check;
ALTER TABLE battlecity_players ADD CONSTRAINT battlecity_provider_check
  CHECK (provider IN ('guest', 'wallet')) NOT VALID;
ALTER TABLE battlecity_sessions DROP CONSTRAINT IF EXISTS battlecity_session_provider_check;
ALTER TABLE battlecity_sessions ADD CONSTRAINT battlecity_session_provider_check
  CHECK (provider IN ('guest', 'wallet')) NOT VALID;
ALTER TABLE battlecity_economy_accounts DROP CONSTRAINT IF EXISTS battlecity_economy_provider_check;
ALTER TABLE battlecity_economy_accounts ADD CONSTRAINT battlecity_economy_provider_check
  CHECK (provider IN ('guest', 'wallet')) NOT VALID;
