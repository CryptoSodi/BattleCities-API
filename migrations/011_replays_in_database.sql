-- Replays are API-owned data. Keep the complete replay payload in PostgreSQL
-- instead of depending on external object storage.
ALTER TABLE battlecity_replays
  ADD COLUMN IF NOT EXISTS replay_json JSONB;

ALTER TABLE battlecity_replays
  ALTER COLUMN replay_blob_path DROP NOT NULL;

ALTER TABLE battlecity_replays
  ALTER COLUMN replay_blob_url DROP NOT NULL;
