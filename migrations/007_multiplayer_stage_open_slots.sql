ALTER TABLE battlecity_multiplayer_matches
  ADD COLUMN IF NOT EXISTS open_slots INTEGER[] NOT NULL DEFAULT '{}';

ALTER TABLE battlecity_multiplayer_matches
  ADD CONSTRAINT battlecity_multiplayer_match_open_slots_check
    CHECK (
      open_slots <@ ARRAY[0, 1]::INTEGER[] AND
      cardinality(open_slots) <= 2
    );
