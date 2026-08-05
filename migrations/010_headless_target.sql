ALTER TABLE battlecity_multiplayer_matches
  ADD COLUMN IF NOT EXISTS headless_target TEXT NULL;

ALTER TABLE battlecity_multiplayer_matches
  DROP CONSTRAINT IF EXISTS battlecity_multiplayer_headless_target_check;

ALTER TABLE battlecity_multiplayer_matches
  ADD CONSTRAINT battlecity_multiplayer_headless_target_check
  CHECK (headless_target IS NULL OR headless_target IN ('worker', 'bom1', 'usa'));
