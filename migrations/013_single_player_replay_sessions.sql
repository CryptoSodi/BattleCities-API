-- An offline single-player run can span several completed stages. Each stage
-- retains an independently playable replay, while this parent row represents
-- the overall run.
CREATE TABLE IF NOT EXISTS battlecity_single_player_sessions (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL,
  player_id TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed')),
  stage_count INTEGER NOT NULL DEFAULT 0 CHECK (stage_count >= 0),
  last_stage_number INTEGER,
  final_score INTEGER,
  final_result TEXT CHECK (final_result IN ('win', 'loss'))
);

CREATE INDEX IF NOT EXISTS battlecity_single_player_sessions_guest_started_idx
  ON battlecity_single_player_sessions (guest_id, started_at DESC);

CREATE INDEX IF NOT EXISTS battlecity_single_player_sessions_player_started_idx
  ON battlecity_single_player_sessions (player_id, started_at DESC);

ALTER TABLE battlecity_replays
  ADD COLUMN IF NOT EXISTS single_player_session_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'battlecity_replays_single_player_session_fk'
  ) THEN
    ALTER TABLE battlecity_replays
      ADD CONSTRAINT battlecity_replays_single_player_session_fk
      FOREIGN KEY (single_player_session_id)
      REFERENCES battlecity_single_player_sessions(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS battlecity_replays_single_player_session_stage_idx
  ON battlecity_replays (single_player_session_id, level_number);
