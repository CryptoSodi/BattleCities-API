CREATE TABLE IF NOT EXISTS battlecity_multiplayer_matches (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  event_id TEXT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  closed_at TIMESTAMPTZ NULL,
  CONSTRAINT battlecity_multiplayer_match_category_check
    CHECK (category IN ('direct', 'event')),
  CONSTRAINT battlecity_multiplayer_match_status_check
    CHECK (status IN ('waiting', 'ready', 'live', 'completed', 'closed')),
  CONSTRAINT battlecity_multiplayer_match_event_check
    CHECK (
      (category = 'direct' AND event_id IS NULL) OR
      (category = 'event' AND event_id IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS battlecity_multiplayer_participants (
  match_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  player_slot INTEGER NOT NULL,
  join_token_hash TEXT NOT NULL,
  fuel_charged INTEGER NOT NULL DEFAULT 0,
  fuel_refunded INTEGER NOT NULL DEFAULT 0,
  joined_at TIMESTAMPTZ NOT NULL,
  left_at TIMESTAMPTZ NULL,
  PRIMARY KEY (match_id, player_id),
  UNIQUE (match_id, player_slot),
  CONSTRAINT battlecity_multiplayer_participant_match_fk
    FOREIGN KEY (match_id) REFERENCES battlecity_multiplayer_matches(id)
    ON DELETE CASCADE,
  CONSTRAINT battlecity_multiplayer_participant_player_fk
    FOREIGN KEY (player_id) REFERENCES battlecity_players(id)
    ON DELETE CASCADE,
  CONSTRAINT battlecity_multiplayer_participant_slot_check
    CHECK (player_slot IN (0, 1)),
  CONSTRAINT battlecity_multiplayer_participant_fuel_check
    CHECK (
      fuel_charged >= 0 AND
      fuel_refunded >= 0 AND
      fuel_refunded <= fuel_charged
    )
);

CREATE TABLE IF NOT EXISTS battlecity_multiplayer_event_entries (
  event_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  fuel_cost INTEGER NOT NULL,
  entered_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (event_id, player_id),
  CONSTRAINT battlecity_multiplayer_event_entry_player_fk
    FOREIGN KEY (player_id) REFERENCES battlecity_players(id)
    ON DELETE CASCADE,
  CONSTRAINT battlecity_multiplayer_event_entry_fuel_check
    CHECK (fuel_cost >= 0)
);

CREATE TABLE IF NOT EXISTS battlecity_multiplayer_scores (
  match_id TEXT NOT NULL,
  event_id TEXT NULL,
  player_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  validation_status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (match_id, player_id),
  CONSTRAINT battlecity_multiplayer_score_match_fk
    FOREIGN KEY (match_id) REFERENCES battlecity_multiplayer_matches(id)
    ON DELETE CASCADE,
  CONSTRAINT battlecity_multiplayer_score_player_fk
    FOREIGN KEY (player_id) REFERENCES battlecity_players(id)
    ON DELETE CASCADE,
  CONSTRAINT battlecity_multiplayer_score_value_check
    CHECK (
      score >= 0 AND
      validation_status IN ('pending', 'accepted', 'rejected')
    )
);

CREATE TABLE IF NOT EXISTS battlecity_event_prize_approvals (
  event_id TEXT PRIMARY KEY,
  allocations_json JSONB NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS battlecity_multiplayer_open_match_idx
  ON battlecity_multiplayer_matches (category, event_id, status, created_at);
CREATE INDEX IF NOT EXISTS battlecity_multiplayer_player_idx
  ON battlecity_multiplayer_participants (player_id, joined_at DESC);
CREATE INDEX IF NOT EXISTS battlecity_multiplayer_event_score_idx
  ON battlecity_multiplayer_scores (event_id, score DESC)
  WHERE validation_status <> 'rejected';
