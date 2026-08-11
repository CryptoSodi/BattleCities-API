-- Link single-player replays to the signed-in player (when present) so admin
-- and profile views can show a real name instead of the anonymous replay cookie.
ALTER TABLE battlecity_replays
  ADD COLUMN IF NOT EXISTS player_id TEXT;

CREATE INDEX IF NOT EXISTS battlecity_replays_player_created_idx
  ON battlecity_replays (player_id, created_at DESC);