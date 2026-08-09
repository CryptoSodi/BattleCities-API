UPDATE battlecity_multiplayer_matches
SET headless_target = 'worker'
WHERE headless_target = 'usa';

ALTER TABLE battlecity_multiplayer_matches
  DROP CONSTRAINT IF EXISTS battlecity_multiplayer_headless_target_check;

ALTER TABLE battlecity_multiplayer_matches
  ADD CONSTRAINT battlecity_multiplayer_headless_target_check
  CHECK (headless_target IS NULL OR headless_target IN ('worker', 'bom1'));
