-- Cherry sessions hold the verified payment wallet without changing the
-- existing player and economy provider constraints.
ALTER TABLE battlecity_sessions DROP CONSTRAINT IF EXISTS battlecity_session_provider_check;
ALTER TABLE battlecity_sessions ADD CONSTRAINT battlecity_session_provider_check
  CHECK (provider IN ('guest', 'wallet', 'cherry')) NOT VALID;
