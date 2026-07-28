CREATE TABLE IF NOT EXISTS battlecity_match_archives (
  match_id TEXT PRIMARY KEY,
  archive_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  game_type TEXT NOT NULL,
  category TEXT NOT NULL,
  level_number INTEGER NOT NULL,
  seed BIGINT NOT NULL,
  simulation_config_json JSONB NOT NULL,
  players_json JSONB NOT NULL,
  result_json JSONB NULL,
  frame_count INTEGER NOT NULL DEFAULT 0,
  first_frame_seq INTEGER NULL,
  last_frame_seq INTEGER NULL,
  final_tick INTEGER NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT battlecity_match_archive_version_check
    CHECK (archive_version = 1),
  CONSTRAINT battlecity_match_archive_status_check
    CHECK (status IN ('recording', 'completed', 'failed')),
  CONSTRAINT battlecity_match_archive_category_check
    CHECK (category IN ('guest', 'live', 'event')),
  CONSTRAINT battlecity_match_archive_level_check
    CHECK (level_number BETWEEN 1 AND 35),
  CONSTRAINT battlecity_match_archive_frame_count_check
    CHECK (frame_count >= 0),
  CONSTRAINT battlecity_match_archive_sequence_check
    CHECK (
      (frame_count = 0 AND first_frame_seq IS NULL AND last_frame_seq IS NULL) OR
      (
        frame_count > 0 AND
        first_frame_seq IS NOT NULL AND
        last_frame_seq IS NOT NULL AND
        first_frame_seq > 0 AND
        last_frame_seq >= first_frame_seq
      )
    )
);

CREATE TABLE IF NOT EXISTS battlecity_match_archive_batches (
  match_id TEXT NOT NULL,
  start_seq INTEGER NOT NULL,
  end_seq INTEGER NOT NULL,
  frame_count INTEGER NOT NULL,
  frames_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (match_id, start_seq),
  CONSTRAINT battlecity_match_archive_batch_match_fk
    FOREIGN KEY (match_id) REFERENCES battlecity_match_archives(match_id)
    ON DELETE CASCADE,
  CONSTRAINT battlecity_match_archive_batch_sequence_check
    CHECK (start_seq > 0 AND end_seq >= start_seq),
  CONSTRAINT battlecity_match_archive_batch_count_check
    CHECK (
      frame_count > 0 AND
      frame_count = end_seq - start_seq + 1 AND
      jsonb_typeof(frames_json) = 'array' AND
      jsonb_array_length(frames_json) = frame_count
    )
);

CREATE INDEX IF NOT EXISTS battlecity_match_archives_completed_idx
  ON battlecity_match_archives (completed_at DESC, started_at DESC)
  WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS battlecity_match_archive_batches_match_idx
  ON battlecity_match_archive_batches (match_id, start_seq);
