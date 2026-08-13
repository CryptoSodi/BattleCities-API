DELETE FROM battlecity_sessions WHERE provider = 'guest';

ALTER TABLE battlecity_players
  DROP CONSTRAINT IF EXISTS battlecity_provider_check;
ALTER TABLE battlecity_players
  ADD CONSTRAINT battlecity_provider_check
  CHECK (provider IN ('wallet', 'google')) NOT VALID;

ALTER TABLE battlecity_sessions
  ADD CONSTRAINT battlecity_session_provider_check
  CHECK (provider IN ('wallet', 'google')) NOT VALID;

ALTER TABLE battlecity_economy_accounts
  ADD CONSTRAINT battlecity_economy_provider_check
  CHECK (provider IN ('wallet', 'google')) NOT VALID;
