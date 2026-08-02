CREATE TABLE IF NOT EXISTS battlecity_tournaments (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  entry_fuel_cost INTEGER NOT NULL DEFAULT 1,
  level_number INTEGER NOT NULL DEFAULT 1,
  prize_currency TEXT NOT NULL DEFAULT 'token',
  prize_pool BIGINT NOT NULL DEFAULT 0,
  created_by_player_id TEXT NOT NULL,
  updated_by_player_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  prizes_distributed_at TIMESTAMPTZ NULL,
  prizes_distributed_by_player_id TEXT NULL,
  CONSTRAINT battlecity_tournament_status_check
    CHECK (status IN ('draft', 'scheduled', 'live', 'ended', 'cancelled')),
  CONSTRAINT battlecity_tournament_dates_check CHECK (ends_at > starts_at),
  CONSTRAINT battlecity_tournament_entry_check CHECK (entry_fuel_cost >= 0),
  CONSTRAINT battlecity_tournament_level_check CHECK (level_number BETWEEN 1 AND 35),
  CONSTRAINT battlecity_tournament_currency_check
    CHECK (prize_currency IN ('token', 'fuel')),
  CONSTRAINT battlecity_tournament_pool_check CHECK (prize_pool >= 0),
  CONSTRAINT battlecity_tournament_created_by_fk
    FOREIGN KEY (created_by_player_id) REFERENCES battlecity_players(id),
  CONSTRAINT battlecity_tournament_updated_by_fk
    FOREIGN KEY (updated_by_player_id) REFERENCES battlecity_players(id),
  CONSTRAINT battlecity_tournament_distributed_by_fk
    FOREIGN KEY (prizes_distributed_by_player_id) REFERENCES battlecity_players(id)
);

CREATE TABLE IF NOT EXISTS battlecity_tournament_prize_distributions (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  currency TEXT NOT NULL,
  amount BIGINT NOT NULL,
  distributed_by_player_id TEXT NOT NULL,
  distributed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT battlecity_tournament_prize_tournament_fk
    FOREIGN KEY (tournament_id) REFERENCES battlecity_tournaments(id)
    ON DELETE CASCADE,
  CONSTRAINT battlecity_tournament_prize_player_fk
    FOREIGN KEY (player_id) REFERENCES battlecity_players(id),
  CONSTRAINT battlecity_tournament_prize_admin_fk
    FOREIGN KEY (distributed_by_player_id) REFERENCES battlecity_players(id),
  CONSTRAINT battlecity_tournament_prize_rank_check CHECK (rank > 0),
  CONSTRAINT battlecity_tournament_prize_currency_check
    CHECK (currency IN ('token', 'fuel')),
  CONSTRAINT battlecity_tournament_prize_amount_check CHECK (amount > 0),
  UNIQUE (tournament_id, player_id)
);

CREATE INDEX IF NOT EXISTS battlecity_tournaments_status_dates_idx
  ON battlecity_tournaments (status, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS battlecity_tournament_prizes_tournament_idx
  ON battlecity_tournament_prize_distributions
  (tournament_id, rank, player_id);
