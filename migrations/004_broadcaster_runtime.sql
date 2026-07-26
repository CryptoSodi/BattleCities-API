ALTER TABLE battlecity_multiplayer_matches
  ADD COLUMN IF NOT EXISTS broadcaster_status TEXT NULL,
  ADD COLUMN IF NOT EXISTS broadcaster_started_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS broadcaster_worker_url TEXT NULL;

ALTER TABLE battlecity_multiplayer_matches
  DROP CONSTRAINT IF EXISTS battlecity_multiplayer_broadcaster_status_check;

ALTER TABLE battlecity_multiplayer_matches
  ADD CONSTRAINT battlecity_multiplayer_broadcaster_status_check
  CHECK (
    broadcaster_status IS NULL OR
    broadcaster_status IN ('starting', 'running', 'stopped', 'failed')
  );
