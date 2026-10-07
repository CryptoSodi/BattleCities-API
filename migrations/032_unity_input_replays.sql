-- Additive, reviewable rollout: legacy sessions, recordings and users stay intact.
CREATE TABLE IF NOT EXISTS battlecity_unity_replay_sessions (
  id TEXT PRIMARY KEY CHECK (id ~ '^urs-[a-f0-9]{32}$'),
  player_id TEXT NOT NULL REFERENCES battlecity_players(id) ON DELETE CASCADE,
  seed BIGINT NOT NULL CHECK (seed BETWEEN 1 AND 4294967295),
  settings_json JSONB NOT NULL CHECK (jsonb_typeof(settings_json) = 'object'),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > issued_at),
  replay_id TEXT UNIQUE REFERENCES battlecity_replays(id) ON DELETE RESTRICT,
  record_json JSONB CHECK (record_json IS NULL OR jsonb_typeof(record_json) = 'object'),
  match_result_id TEXT UNIQUE REFERENCES battlecity_match_results(id) ON DELETE RESTRICT,
  CHECK ((replay_id IS NULL AND record_json IS NULL AND match_result_id IS NULL) OR
    (replay_id IS NOT NULL AND record_json IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS battlecity_unity_replay_sessions_player_issued_idx
  ON battlecity_unity_replay_sessions (player_id, issued_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS battlecity_unity_replay_result_unique_idx
  ON battlecity_match_results (replay_id) WHERE replay_id LIKE 'urp-%';
