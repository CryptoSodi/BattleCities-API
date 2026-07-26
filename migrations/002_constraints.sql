CREATE UNIQUE INDEX IF NOT EXISTS battlecity_seasons_number_uidx
  ON battlecity_seasons (number);
CREATE INDEX IF NOT EXISTS battlecity_players_provider_created_idx
  ON battlecity_players (provider, created_at DESC);
CREATE INDEX IF NOT EXISTS battlecity_sessions_provider_created_idx
  ON battlecity_sessions (provider, created_at DESC);
CREATE INDEX IF NOT EXISTS battlecity_sessions_player_idx
  ON battlecity_sessions (player_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS battlecity_economy_accounts_provider_idx
  ON battlecity_economy_accounts (provider, updated_at DESC);
CREATE INDEX IF NOT EXISTS battlecity_ledger_entries_player_idx
  ON battlecity_ledger_entries (player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS battlecity_ledger_entries_source_idx
  ON battlecity_ledger_entries (source_type, source_id);
CREATE INDEX IF NOT EXISTS battlecity_seasons_window_idx
  ON battlecity_seasons (starts_at, ends_at);
CREATE INDEX IF NOT EXISTS battlecity_match_results_season_idx
  ON battlecity_match_results (season_id, player_id);
CREATE INDEX IF NOT EXISTS battlecity_match_results_player_idx
  ON battlecity_match_results (player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS battlecity_replays_guest_created_idx
  ON battlecity_replays (guest_id, created_at DESC);
CREATE INDEX IF NOT EXISTS battlecity_event_currency_event_idx
  ON battlecity_event_currency_balances (event_id, currency, amount DESC);
CREATE INDEX IF NOT EXISTS battlecity_trading_volume_player_idx
  ON battlecity_trading_volume (player_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS battlecity_webrtc_signals_latest_idx
  ON battlecity_webrtc_signals (match_id, player_index, kind);
CREATE INDEX IF NOT EXISTS battlecity_webrtc_signals_created_idx
  ON battlecity_webrtc_signals (created_at);
CREATE INDEX IF NOT EXISTS battlecity_webrtc_observers_updated_idx
  ON battlecity_webrtc_observers (updated_at);
CREATE INDEX IF NOT EXISTS battlecity_wallet_challenges_created_idx
  ON battlecity_wallet_challenges (created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'battlecity_sessions_player_fk') THEN
    ALTER TABLE battlecity_sessions ADD CONSTRAINT battlecity_sessions_player_fk
      FOREIGN KEY (player_id) REFERENCES battlecity_players(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'battlecity_economy_player_fk') THEN
    ALTER TABLE battlecity_economy_accounts ADD CONSTRAINT battlecity_economy_player_fk
      FOREIGN KEY (player_id) REFERENCES battlecity_players(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'battlecity_match_player_fk') THEN
    ALTER TABLE battlecity_match_results ADD CONSTRAINT battlecity_match_player_fk
      FOREIGN KEY (player_id) REFERENCES battlecity_players(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'battlecity_match_season_fk') THEN
    ALTER TABLE battlecity_match_results ADD CONSTRAINT battlecity_match_season_fk
      FOREIGN KEY (season_id) REFERENCES battlecity_seasons(id) ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'battlecity_provider_check') THEN
    ALTER TABLE battlecity_players ADD CONSTRAINT battlecity_provider_check
      CHECK (provider IN ('guest', 'wallet', 'google')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'battlecity_economy_balances_check') THEN
    ALTER TABLE battlecity_economy_accounts ADD CONSTRAINT battlecity_economy_balances_check
      CHECK (token_balance >= 0 AND sol_balance >= 0 AND fuel_balance >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'battlecity_match_values_check') THEN
    ALTER TABLE battlecity_match_results ADD CONSTRAINT battlecity_match_values_check
      CHECK (level_number >= 1 AND score >= 0 AND game_points >= 0 AND validation_status IN ('pending', 'accepted', 'rejected')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'battlecity_replay_values_check') THEN
    ALTER TABLE battlecity_replays ADD CONSTRAINT battlecity_replay_values_check
      CHECK (level_number >= 1 AND score >= 0 AND kills >= 0 AND duration_ticks >= 0 AND game_result IN ('win', 'loss') AND validation_status IN ('pending', 'verified', 'rejected')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'battlecity_webrtc_signal_route_check') THEN
    ALTER TABLE battlecity_webrtc_signals ADD CONSTRAINT battlecity_webrtc_signal_route_check
      CHECK (player_index IN (0, 1) AND kind IN ('offer', 'answer')) NOT VALID;
  END IF;
END $$;
