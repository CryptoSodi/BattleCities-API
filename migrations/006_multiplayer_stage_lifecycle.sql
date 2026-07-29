ALTER TABLE battlecity_multiplayer_matches
  ADD COLUMN IF NOT EXISTS current_stage INTEGER NOT NULL DEFAULT 1;

ALTER TABLE battlecity_multiplayer_matches
  DROP CONSTRAINT IF EXISTS battlecity_multiplayer_match_status_check;

ALTER TABLE battlecity_multiplayer_matches
  ADD CONSTRAINT battlecity_multiplayer_match_status_check
    CHECK (status IN (
      'waiting', 'ready', 'live', 'transition', 'completed', 'closed'
    ));

ALTER TABLE battlecity_multiplayer_matches
  ADD CONSTRAINT battlecity_multiplayer_match_stage_check
    CHECK (current_stage >= 1);

ALTER TABLE battlecity_multiplayer_participants
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS joined_stage INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS left_stage INTEGER NULL;

ALTER TABLE battlecity_multiplayer_participants
  DROP CONSTRAINT IF EXISTS battlecity_multiplayer_participants_match_id_player_slot_key;

CREATE UNIQUE INDEX IF NOT EXISTS battlecity_multiplayer_active_slot_idx
  ON battlecity_multiplayer_participants (match_id, player_slot)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS battlecity_multiplayer_stage_queue_idx
  ON battlecity_multiplayer_matches
    (category, event_id, current_stage, status, created_at);
