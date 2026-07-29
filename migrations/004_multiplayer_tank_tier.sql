ALTER TABLE battlecity_multiplayer_participants
  ADD COLUMN IF NOT EXISTS tank_tier TEXT NOT NULL DEFAULT 'a';

ALTER TABLE battlecity_multiplayer_participants
  DROP CONSTRAINT IF EXISTS battlecity_multiplayer_participant_tank_tier_check;

ALTER TABLE battlecity_multiplayer_participants
  ADD CONSTRAINT battlecity_multiplayer_participant_tank_tier_check
  CHECK (tank_tier IN ('a', 'b', 'c', 'd'));
