-- Schema-only CI fixture. Contains no player rows or production credentials.
--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: battlecity_airdrop_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_airdrop_state (
    campaign_id text NOT NULL,
    state_json jsonb NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: battlecity_batc_powerup_drops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_batc_powerup_drops (
    id text NOT NULL,
    request_id text NOT NULL,
    player_id text NOT NULL,
    wallet_address text NOT NULL,
    level_number integer NOT NULL,
    amount integer NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    claimed_at timestamp with time zone,
    delivery_signature text,
    delivery_raw_transaction text,
    delivery_blockhash text,
    delivery_last_valid_block_height bigint,
    delivery_error text,
    CONSTRAINT battlecity_batc_powerup_drop_amount_check CHECK ((amount = ANY (ARRAY[0, 100, 200]))),
    CONSTRAINT battlecity_batc_powerup_drop_status_check CHECK ((status = ANY (ARRAY['none'::text, 'issued'::text, 'delivering'::text, 'delivered'::text, 'failed'::text])))
);


--
-- Name: battlecity_competition_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_competition_settings (
    id integer NOT NULL,
    settings jsonb NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT battlecity_competition_settings_id_check CHECK ((id = 1))
);


--
-- Name: battlecity_discord_follow_rewards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_discord_follow_rewards (
    player_id text NOT NULL,
    discord_user_id text NOT NULL,
    fuel_amount integer NOT NULL,
    awarded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT battlecity_discord_follow_rewards_discord_user_id_check CHECK ((discord_user_id ~ '^[0-9]{16,22}$'::text)),
    CONSTRAINT battlecity_discord_follow_rewards_fuel_amount_check CHECK ((fuel_amount = 5))
);


--
-- Name: battlecity_discord_verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_discord_verifications (
    player_id text NOT NULL,
    discord_user_id text,
    discord_username text,
    code_hash text,
    code_expires_at timestamp with time zone,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: battlecity_economy_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_economy_accounts (
    player_id text NOT NULL,
    provider text NOT NULL,
    wallet_address text,
    token_balance bigint NOT NULL,
    sol_balance numeric(18,6) NOT NULL,
    fuel_balance integer DEFAULT 5 NOT NULL,
    inventory_json jsonb NOT NULL,
    loadout_json jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: battlecity_event_currency_balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_event_currency_balances (
    player_id text NOT NULL,
    event_id text NOT NULL,
    currency text NOT NULL,
    amount numeric(18,2) NOT NULL,
    display_name text DEFAULT 'Player'::text NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: battlecity_event_prize_approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_event_prize_approvals (
    event_id text NOT NULL,
    allocations_json jsonb NOT NULL,
    approved_at timestamp with time zone NOT NULL
);


--
-- Name: battlecity_leaderboard_rows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_leaderboard_rows (
    scope text NOT NULL,
    season_id text NOT NULL,
    rank integer NOT NULL,
    player_id text NOT NULL,
    wallet_address text,
    display_name text NOT NULL,
    points bigint NOT NULL,
    perk_badges_json jsonb NOT NULL,
    snapshot_at timestamp with time zone NOT NULL
);


--
-- Name: battlecity_ledger_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_ledger_entries (
    id text NOT NULL,
    player_id text NOT NULL,
    wallet_address text,
    currency text NOT NULL,
    amount numeric(18,6) NOT NULL,
    reason text NOT NULL,
    source_type text NOT NULL,
    source_id text,
    season_id text,
    phase_id text,
    event_id text,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: battlecity_match_archive_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_match_archive_batches (
    match_id text NOT NULL,
    start_seq integer NOT NULL,
    end_seq integer NOT NULL,
    frame_count integer NOT NULL,
    frames_json jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT battlecity_match_archive_batch_count_check CHECK (((frame_count > 0) AND (frame_count = ((end_seq - start_seq) + 1)) AND (jsonb_typeof(frames_json) = 'array'::text) AND (jsonb_array_length(frames_json) = frame_count))),
    CONSTRAINT battlecity_match_archive_batch_sequence_check CHECK (((start_seq > 0) AND (end_seq >= start_seq)))
);


--
-- Name: battlecity_match_archives; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_match_archives (
    match_id text NOT NULL,
    archive_version integer DEFAULT 1 NOT NULL,
    status text NOT NULL,
    game_type text NOT NULL,
    category text NOT NULL,
    level_number integer NOT NULL,
    seed bigint NOT NULL,
    simulation_config_json jsonb NOT NULL,
    players_json jsonb NOT NULL,
    result_json jsonb,
    frame_count integer DEFAULT 0 NOT NULL,
    first_frame_seq integer,
    last_frame_seq integer,
    final_tick integer,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT battlecity_match_archive_category_check CHECK ((category = ANY (ARRAY['guest'::text, 'live'::text, 'event'::text]))),
    CONSTRAINT battlecity_match_archive_frame_count_check CHECK ((frame_count >= 0)),
    CONSTRAINT battlecity_match_archive_level_check CHECK (((level_number >= 1) AND (level_number <= 35))),
    CONSTRAINT battlecity_match_archive_sequence_check CHECK ((((frame_count = 0) AND (first_frame_seq IS NULL) AND (last_frame_seq IS NULL)) OR ((frame_count > 0) AND (first_frame_seq IS NOT NULL) AND (last_frame_seq IS NOT NULL) AND (first_frame_seq > 0) AND (last_frame_seq >= first_frame_seq)))),
    CONSTRAINT battlecity_match_archive_status_check CHECK ((status = ANY (ARRAY['recording'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT battlecity_match_archive_version_check CHECK ((archive_version = 1))
);


--
-- Name: battlecity_match_prize_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_match_prize_reviews (
    result_id text NOT NULL,
    decision text NOT NULL,
    reviewer_id text NOT NULL,
    reason text NOT NULL,
    reviewed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT battlecity_match_prize_reviews_decision_check CHECK ((decision = ANY (ARRAY['accepted'::text, 'rejected'::text])))
);


--
-- Name: battlecity_match_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_match_results (
    id text NOT NULL,
    player_id text NOT NULL,
    wallet_address text,
    display_name text NOT NULL,
    season_id text NOT NULL,
    mode text NOT NULL,
    level_number integer NOT NULL,
    score integer NOT NULL,
    game_points integer NOT NULL,
    won boolean NOT NULL,
    replay_id text,
    validation_status text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    provider text DEFAULT 'wallet'::text NOT NULL
);


--
-- Name: battlecity_multiplayer_event_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_multiplayer_event_entries (
    event_id text NOT NULL,
    player_id text NOT NULL,
    fuel_cost integer NOT NULL,
    entered_at timestamp with time zone NOT NULL,
    CONSTRAINT battlecity_multiplayer_event_entry_fuel_check CHECK ((fuel_cost >= 0))
);


--
-- Name: battlecity_multiplayer_matches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_multiplayer_matches (
    id text NOT NULL,
    category text NOT NULL,
    event_id text,
    status text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    closed_at timestamp with time zone,
    broadcaster_status text,
    broadcaster_started_at timestamp with time zone,
    broadcaster_worker_url text,
    current_stage integer DEFAULT 1 NOT NULL,
    open_slots integer[] DEFAULT '{}'::integer[] NOT NULL,
    headless_target text,
    CONSTRAINT battlecity_multiplayer_broadcaster_status_check CHECK (((broadcaster_status IS NULL) OR (broadcaster_status = ANY (ARRAY['starting'::text, 'running'::text, 'stopped'::text, 'failed'::text])))),
    CONSTRAINT battlecity_multiplayer_headless_target_check CHECK (((headless_target IS NULL) OR (headless_target = ANY (ARRAY['worker'::text, 'bom1'::text])))),
    CONSTRAINT battlecity_multiplayer_match_category_check CHECK ((category = ANY (ARRAY['direct'::text, 'event'::text]))),
    CONSTRAINT battlecity_multiplayer_match_event_check CHECK ((((category = 'direct'::text) AND (event_id IS NULL)) OR ((category = 'event'::text) AND (event_id IS NOT NULL)))),
    CONSTRAINT battlecity_multiplayer_match_open_slots_check CHECK (((open_slots <@ ARRAY[0, 1]) AND (cardinality(open_slots) <= 2))),
    CONSTRAINT battlecity_multiplayer_match_stage_check CHECK ((current_stage >= 1)),
    CONSTRAINT battlecity_multiplayer_match_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'ready'::text, 'live'::text, 'transition'::text, 'completed'::text, 'closed'::text])))
);


--
-- Name: battlecity_multiplayer_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_multiplayer_participants (
    match_id text NOT NULL,
    player_id text NOT NULL,
    player_slot integer NOT NULL,
    join_token_hash text NOT NULL,
    fuel_charged integer DEFAULT 0 NOT NULL,
    fuel_refunded integer DEFAULT 0 NOT NULL,
    joined_at timestamp with time zone NOT NULL,
    left_at timestamp with time zone,
    tank_tier text DEFAULT 'a'::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    joined_stage integer DEFAULT 1 NOT NULL,
    left_stage integer,
    CONSTRAINT battlecity_multiplayer_participant_fuel_check CHECK (((fuel_charged >= 0) AND (fuel_refunded >= 0) AND (fuel_refunded <= fuel_charged))),
    CONSTRAINT battlecity_multiplayer_participant_slot_check CHECK ((player_slot = ANY (ARRAY[0, 1]))),
    CONSTRAINT battlecity_multiplayer_participant_tank_tier_check CHECK ((tank_tier = ANY (ARRAY['a'::text, 'b'::text, 'c'::text, 'd'::text])))
);


--
-- Name: battlecity_multiplayer_scores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_multiplayer_scores (
    match_id text NOT NULL,
    event_id text,
    player_id text NOT NULL,
    score integer NOT NULL,
    validation_status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT battlecity_multiplayer_score_value_check CHECK (((score >= 0) AND (validation_status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text]))))
);


--
-- Name: battlecity_native_oauth; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_native_oauth (
    token_hash text NOT NULL,
    provider text NOT NULL,
    player_id text NOT NULL,
    payload jsonb NOT NULL,
    status text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT battlecity_native_oauth_provider_check CHECK ((provider = ANY (ARRAY['x'::text, 'discord'::text]))),
    CONSTRAINT battlecity_native_oauth_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'exchanging'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: battlecity_players; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_players (
    id text NOT NULL,
    provider text NOT NULL,
    display_name text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone NOT NULL,
    wallet_address text,
    google_subject text,
    google_email text,
    google_name text,
    google_picture text,
    highscore_primary bigint DEFAULT 0 NOT NULL,
    highscore_secondary bigint DEFAULT 0 NOT NULL
);


--
-- Name: battlecity_presale_allocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_presale_allocations (
    signature text NOT NULL,
    quote_id text NOT NULL,
    wallet_address text NOT NULL,
    payment_method text NOT NULL,
    payment_atomic numeric(30,0) NOT NULL,
    usd_micros numeric(30,0) NOT NULL,
    token_micros numeric(30,0) NOT NULL,
    stage_id smallint NOT NULL,
    confirmed_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    delivery_status text DEFAULT 'pending'::text NOT NULL,
    delivery_transaction_signature text,
    delivery_attempts integer DEFAULT 0 NOT NULL,
    delivery_failure_reason text,
    delivery_started_at timestamp with time zone,
    delivery_confirmed_at timestamp with time zone,
    delivery_raw_transaction text,
    delivery_blockhash text,
    delivery_last_valid_block_height bigint,
    CONSTRAINT battlecity_presale_allocations_delivery_attempts_check CHECK ((delivery_attempts >= 0)),
    CONSTRAINT battlecity_presale_allocations_delivery_status_check CHECK ((delivery_status = ANY (ARRAY['pending'::text, 'sending'::text, 'delivered'::text, 'failed'::text]))),
    CONSTRAINT battlecity_presale_allocations_payment_method_check CHECK ((payment_method = 'SOL'::text)),
    CONSTRAINT battlecity_presale_allocations_stage_id_check CHECK (((stage_id >= 1) AND (stage_id <= 3)))
);


--
-- Name: battlecity_presale_quotes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_presale_quotes (
    quote_id text NOT NULL,
    wallet_address text NOT NULL,
    payment_atomic numeric(30,0) NOT NULL,
    usd_micros numeric(30,0) NOT NULL,
    token_micros numeric(30,0) NOT NULL,
    stage_id smallint NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_signature text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT battlecity_presale_quotes_stage_id_check CHECK (((stage_id >= 1) AND (stage_id <= 3)))
);


--
-- Name: battlecity_push_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_push_devices (
    token text NOT NULL,
    player_id text,
    platform text DEFAULT 'android'::text NOT NULL,
    permission_state text DEFAULT 'unknown'::text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone NOT NULL
);


--
-- Name: battlecity_quest_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_quest_progress (
    player_id text NOT NULL,
    quest_id text NOT NULL,
    value numeric(18,2) NOT NULL,
    claimed_at timestamp with time zone,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: battlecity_ranking_payouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_ranking_payouts (
    id text NOT NULL,
    period_id text NOT NULL,
    player_id text NOT NULL,
    wallet_address text,
    rank integer NOT NULL,
    amount text NOT NULL,
    token_config jsonb NOT NULL,
    status text NOT NULL,
    delivery jsonb,
    error text,
    paid_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT battlecity_ranking_payouts_rank_check CHECK ((rank > 0)),
    CONSTRAINT battlecity_ranking_payouts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'wallet_required'::text, 'prepared'::text, 'paid'::text, 'failed'::text])))
);


--
-- Name: battlecity_ranking_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_ranking_periods (
    id text NOT NULL,
    kind text NOT NULL,
    scope text NOT NULL,
    season_id text,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    policy jsonb NOT NULL,
    rows_json jsonb,
    closed_at timestamp with time zone,
    CONSTRAINT battlecity_ranking_periods_check CHECK ((starts_at < ends_at)),
    CONSTRAINT battlecity_ranking_periods_kind_check CHECK ((kind = ANY (ARRAY['cycle'::text, 'season'::text]))),
    CONSTRAINT battlecity_ranking_periods_scope_check CHECK ((scope = ANY (ARRAY['gaming'::text, 'trading'::text])))
);


--
-- Name: battlecity_replays; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_replays (
    id text NOT NULL,
    guest_id text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    level_number integer NOT NULL,
    score integer DEFAULT 0 NOT NULL,
    kills integer DEFAULT 0 NOT NULL,
    game_result text DEFAULT 'loss'::text NOT NULL,
    duration_ticks integer DEFAULT 0 NOT NULL,
    replay_blob_path text,
    replay_blob_url text,
    validation_status text DEFAULT 'pending'::text NOT NULL,
    replay_json jsonb,
    player_id text,
    single_player_session_id text
);


--
-- Name: battlecity_schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_schema_migrations (
    version text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: battlecity_season_passes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_season_passes (
    player_id text NOT NULL,
    season_id text NOT NULL,
    purchased_at timestamp with time zone NOT NULL,
    eligible_from timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    payment_signature text NOT NULL,
    CONSTRAINT battlecity_season_passes_check CHECK (((eligible_from <= purchased_at) AND (purchased_at < expires_at)))
);


--
-- Name: battlecity_seasons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_seasons (
    id text NOT NULL,
    number integer NOT NULL,
    name text NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    status text NOT NULL,
    reward_pool text,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: battlecity_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_sessions (
    id text NOT NULL,
    provider text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone NOT NULL,
    player_id text,
    wallet_address text,
    google_subject text,
    google_email text,
    google_name text,
    google_picture text
);


--
-- Name: battlecity_shop_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_shop_payments (
    signature text NOT NULL,
    quote_id text NOT NULL,
    player_id text NOT NULL,
    wallet_address text NOT NULL,
    item_id text NOT NULL,
    currency text NOT NULL,
    amount_atomic numeric(30,0) NOT NULL,
    confirmed_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT battlecity_shop_payments_amount_check CHECK ((amount_atomic > (0)::numeric)),
    CONSTRAINT battlecity_shop_payments_currency_check CHECK ((currency = ANY (ARRAY['sol'::text, 'token'::text, 'skr'::text])))
);


--
-- Name: battlecity_single_player_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_single_player_sessions (
    id text NOT NULL,
    guest_id text NOT NULL,
    player_id text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    status text DEFAULT 'active'::text NOT NULL,
    stage_count integer DEFAULT 0 NOT NULL,
    last_stage_number integer,
    final_score integer,
    final_result text,
    CONSTRAINT battlecity_single_player_sessions_final_result_check CHECK ((final_result = ANY (ARRAY['win'::text, 'loss'::text]))),
    CONSTRAINT battlecity_single_player_sessions_stage_count_check CHECK ((stage_count >= 0)),
    CONSTRAINT battlecity_single_player_sessions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'completed'::text])))
);


--
-- Name: battlecity_site_presence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_site_presence (
    visitor_id text NOT NULL,
    client_id text NOT NULL,
    player_id text,
    in_game boolean DEFAULT false NOT NULL,
    game_mode text,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT battlecity_site_presence_mode_check CHECK (((game_mode IS NULL) OR (game_mode = ANY (ARRAY['single-player'::text, 'multiplayer'::text]))))
);


--
-- Name: battlecity_site_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_site_settings (
    setting_key text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT battlecity_site_settings_key_check CHECK ((setting_key = 'live_users_enabled'::text))
);


--
-- Name: battlecity_staking_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_staking_state (
    id integer NOT NULL,
    state_json jsonb NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: battlecity_swap_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_swap_executions (
    signature text NOT NULL,
    player_id text NOT NULL,
    request_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: battlecity_tournament_prize_distributions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_tournament_prize_distributions (
    id text NOT NULL,
    tournament_id text NOT NULL,
    player_id text NOT NULL,
    rank integer NOT NULL,
    currency text NOT NULL,
    amount bigint NOT NULL,
    distributed_by_player_id text NOT NULL,
    distributed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT battlecity_tournament_prize_amount_check CHECK ((amount > 0)),
    CONSTRAINT battlecity_tournament_prize_currency_check CHECK ((currency = ANY (ARRAY['token'::text, 'fuel'::text]))),
    CONSTRAINT battlecity_tournament_prize_rank_check CHECK ((rank > 0))
);


--
-- Name: battlecity_tournaments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_tournaments (
    id text NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    entry_fuel_cost integer DEFAULT 1 NOT NULL,
    level_number integer DEFAULT 1 NOT NULL,
    prize_currency text DEFAULT 'token'::text NOT NULL,
    prize_pool bigint DEFAULT 0 NOT NULL,
    created_by_player_id text NOT NULL,
    updated_by_player_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    prizes_distributed_at timestamp with time zone,
    prizes_distributed_by_player_id text,
    CONSTRAINT battlecity_tournament_currency_check CHECK ((prize_currency = ANY (ARRAY['token'::text, 'fuel'::text]))),
    CONSTRAINT battlecity_tournament_dates_check CHECK ((ends_at > starts_at)),
    CONSTRAINT battlecity_tournament_entry_check CHECK ((entry_fuel_cost >= 0)),
    CONSTRAINT battlecity_tournament_level_check CHECK (((level_number >= 1) AND (level_number <= 35))),
    CONSTRAINT battlecity_tournament_pool_check CHECK ((prize_pool >= 0)),
    CONSTRAINT battlecity_tournament_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'scheduled'::text, 'live'::text, 'ended'::text, 'cancelled'::text])))
);


--
-- Name: battlecity_trading_volume; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_trading_volume (
    signature text NOT NULL,
    player_id text NOT NULL,
    wallet_address text,
    mint text NOT NULL,
    trait text NOT NULL,
    volume_usd numeric(18,2) NOT NULL,
    swap_from_mint text NOT NULL,
    swap_to_mint text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    prize_eligible boolean DEFAULT false NOT NULL
);


--
-- Name: battlecity_wallet_challenges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_wallet_challenges (
    nonce text NOT NULL,
    wallet_address text NOT NULL,
    message text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone
);


--
-- Name: battlecity_webrtc_observers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_webrtc_observers (
    match_id text NOT NULL,
    observer_id text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: battlecity_webrtc_signals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_webrtc_signals (
    match_id text NOT NULL,
    player_index integer NOT NULL,
    kind text NOT NULL,
    code text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revision bigint NOT NULL
);


--
-- Name: battlecity_webrtc_signals_revision_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.battlecity_webrtc_signals_revision_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: battlecity_webrtc_signals_revision_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.battlecity_webrtc_signals_revision_seq OWNED BY public.battlecity_webrtc_signals.revision;


--
-- Name: battlecity_x_comment_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_x_comment_claims (
    task_id text NOT NULL,
    player_id text NOT NULL,
    x_user_id text NOT NULL,
    fuel_amount integer NOT NULL,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT battlecity_x_comment_claims_fuel_amount_check CHECK ((fuel_amount = 5)),
    CONSTRAINT battlecity_x_comment_claims_x_user_id_check CHECK ((x_user_id ~ '^[0-9]{1,20}$'::text))
);


--
-- Name: battlecity_x_comment_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_x_comment_tasks (
    id text NOT NULL,
    post_id text NOT NULL,
    post_url text NOT NULL,
    reward_fuel integer DEFAULT 5 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_player_id text,
    CONSTRAINT battlecity_x_comment_tasks_post_id_check CHECK ((post_id ~ '^[0-9]{1,20}$'::text)),
    CONSTRAINT battlecity_x_comment_tasks_reward_fuel_check CHECK ((reward_fuel = 5))
);


--
-- Name: battlecity_x_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_x_connections (
    player_id text NOT NULL,
    x_user_id text NOT NULL,
    x_username text NOT NULL,
    connected_at timestamp with time zone DEFAULT now() NOT NULL,
    follows_battlecities boolean DEFAULT false NOT NULL,
    followed_checked_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT battlecity_x_connections_x_user_id_check CHECK ((x_user_id ~ '^[0-9]{1,20}$'::text)),
    CONSTRAINT battlecity_x_connections_x_username_check CHECK ((x_username ~ '^[A-Za-z0-9_]{1,15}$'::text))
);


--
-- Name: battlecity_x_follow_rewards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_x_follow_rewards (
    player_id text NOT NULL,
    x_user_id text NOT NULL,
    fuel_amount integer NOT NULL,
    awarded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT battlecity_x_follow_rewards_fuel_amount_check CHECK ((fuel_amount = 5)),
    CONSTRAINT battlecity_x_follow_rewards_x_user_id_check CHECK ((x_user_id ~ '^[0-9]{1,20}$'::text))
);


--
-- Name: battlecity_x_repost_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_x_repost_claims (
    task_id text NOT NULL,
    player_id text NOT NULL,
    x_user_id text NOT NULL,
    fuel_amount integer NOT NULL,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT battlecity_x_repost_claims_fuel_amount_check CHECK ((fuel_amount = 5)),
    CONSTRAINT battlecity_x_repost_claims_x_user_id_check CHECK ((x_user_id ~ '^[0-9]{1,20}$'::text))
);


--
-- Name: battlecity_x_repost_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battlecity_x_repost_tasks (
    id text NOT NULL,
    post_id text NOT NULL,
    post_url text NOT NULL,
    reward_fuel integer DEFAULT 5 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_player_id text,
    CONSTRAINT battlecity_x_repost_tasks_post_id_check CHECK ((post_id ~ '^[0-9]{1,20}$'::text)),
    CONSTRAINT battlecity_x_repost_tasks_reward_fuel_check CHECK ((reward_fuel = 5))
);


--
-- Name: battlecity_webrtc_signals revision; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_webrtc_signals ALTER COLUMN revision SET DEFAULT nextval('public.battlecity_webrtc_signals_revision_seq'::regclass);


--
-- Name: battlecity_airdrop_state battlecity_airdrop_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_airdrop_state
    ADD CONSTRAINT battlecity_airdrop_state_pkey PRIMARY KEY (campaign_id);


--
-- Name: battlecity_batc_powerup_drops battlecity_batc_powerup_drop_request_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_batc_powerup_drops
    ADD CONSTRAINT battlecity_batc_powerup_drop_request_unique UNIQUE (player_id, request_id);


--
-- Name: battlecity_batc_powerup_drops battlecity_batc_powerup_drops_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_batc_powerup_drops
    ADD CONSTRAINT battlecity_batc_powerup_drops_pkey PRIMARY KEY (id);


--
-- Name: battlecity_competition_settings battlecity_competition_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_competition_settings
    ADD CONSTRAINT battlecity_competition_settings_pkey PRIMARY KEY (id);


--
-- Name: battlecity_discord_follow_rewards battlecity_discord_follow_rewards_discord_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_discord_follow_rewards
    ADD CONSTRAINT battlecity_discord_follow_rewards_discord_user_id_key UNIQUE (discord_user_id);


--
-- Name: battlecity_discord_follow_rewards battlecity_discord_follow_rewards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_discord_follow_rewards
    ADD CONSTRAINT battlecity_discord_follow_rewards_pkey PRIMARY KEY (player_id);


--
-- Name: battlecity_discord_verifications battlecity_discord_verifications_code_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_discord_verifications
    ADD CONSTRAINT battlecity_discord_verifications_code_hash_key UNIQUE (code_hash);


--
-- Name: battlecity_discord_verifications battlecity_discord_verifications_discord_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_discord_verifications
    ADD CONSTRAINT battlecity_discord_verifications_discord_user_id_key UNIQUE (discord_user_id);


--
-- Name: battlecity_discord_verifications battlecity_discord_verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_discord_verifications
    ADD CONSTRAINT battlecity_discord_verifications_pkey PRIMARY KEY (player_id);


--
-- Name: battlecity_economy_accounts battlecity_economy_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_economy_accounts
    ADD CONSTRAINT battlecity_economy_accounts_pkey PRIMARY KEY (player_id);


--
-- Name: battlecity_economy_accounts battlecity_economy_accounts_wallet_address_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_economy_accounts
    ADD CONSTRAINT battlecity_economy_accounts_wallet_address_key UNIQUE (wallet_address);


--
-- Name: battlecity_economy_accounts battlecity_economy_balances_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.battlecity_economy_accounts
    ADD CONSTRAINT battlecity_economy_balances_check CHECK (((token_balance >= 0) AND (sol_balance >= (0)::numeric) AND (fuel_balance >= 0))) NOT VALID;


--
-- Name: battlecity_economy_accounts battlecity_economy_provider_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.battlecity_economy_accounts
    ADD CONSTRAINT battlecity_economy_provider_check CHECK ((provider = ANY (ARRAY['guest'::text, 'wallet'::text]))) NOT VALID;


--
-- Name: battlecity_event_currency_balances battlecity_event_currency_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_event_currency_balances
    ADD CONSTRAINT battlecity_event_currency_balances_pkey PRIMARY KEY (player_id, event_id, currency);


--
-- Name: battlecity_event_prize_approvals battlecity_event_prize_approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_event_prize_approvals
    ADD CONSTRAINT battlecity_event_prize_approvals_pkey PRIMARY KEY (event_id);


--
-- Name: battlecity_leaderboard_rows battlecity_leaderboard_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_leaderboard_rows
    ADD CONSTRAINT battlecity_leaderboard_rows_pkey PRIMARY KEY (scope, season_id, rank);


--
-- Name: battlecity_ledger_entries battlecity_ledger_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_ledger_entries
    ADD CONSTRAINT battlecity_ledger_entries_pkey PRIMARY KEY (id);


--
-- Name: battlecity_match_archive_batches battlecity_match_archive_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_match_archive_batches
    ADD CONSTRAINT battlecity_match_archive_batches_pkey PRIMARY KEY (match_id, start_seq);


--
-- Name: battlecity_match_archives battlecity_match_archives_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_match_archives
    ADD CONSTRAINT battlecity_match_archives_pkey PRIMARY KEY (match_id);


--
-- Name: battlecity_match_prize_reviews battlecity_match_prize_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_match_prize_reviews
    ADD CONSTRAINT battlecity_match_prize_reviews_pkey PRIMARY KEY (result_id);


--
-- Name: battlecity_match_results battlecity_match_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_match_results
    ADD CONSTRAINT battlecity_match_results_pkey PRIMARY KEY (id);


--
-- Name: battlecity_match_results battlecity_match_values_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.battlecity_match_results
    ADD CONSTRAINT battlecity_match_values_check CHECK (((level_number >= 1) AND (score >= 0) AND (game_points >= 0) AND (validation_status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text])))) NOT VALID;


--
-- Name: battlecity_multiplayer_event_entries battlecity_multiplayer_event_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_multiplayer_event_entries
    ADD CONSTRAINT battlecity_multiplayer_event_entries_pkey PRIMARY KEY (event_id, player_id);


--
-- Name: battlecity_multiplayer_matches battlecity_multiplayer_matches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_multiplayer_matches
    ADD CONSTRAINT battlecity_multiplayer_matches_pkey PRIMARY KEY (id);


--
-- Name: battlecity_multiplayer_participants battlecity_multiplayer_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_multiplayer_participants
    ADD CONSTRAINT battlecity_multiplayer_participants_pkey PRIMARY KEY (match_id, player_id);


--
-- Name: battlecity_multiplayer_scores battlecity_multiplayer_scores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_multiplayer_scores
    ADD CONSTRAINT battlecity_multiplayer_scores_pkey PRIMARY KEY (match_id, player_id);


--
-- Name: battlecity_native_oauth battlecity_native_oauth_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_native_oauth
    ADD CONSTRAINT battlecity_native_oauth_pkey PRIMARY KEY (token_hash);


--
-- Name: battlecity_players battlecity_players_google_subject_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_players
    ADD CONSTRAINT battlecity_players_google_subject_key UNIQUE (google_subject);


--
-- Name: battlecity_players battlecity_players_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_players
    ADD CONSTRAINT battlecity_players_pkey PRIMARY KEY (id);


--
-- Name: battlecity_players battlecity_players_wallet_address_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_players
    ADD CONSTRAINT battlecity_players_wallet_address_key UNIQUE (wallet_address);


--
-- Name: battlecity_presale_allocations battlecity_presale_allocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_presale_allocations
    ADD CONSTRAINT battlecity_presale_allocations_pkey PRIMARY KEY (signature);


--
-- Name: battlecity_presale_allocations battlecity_presale_allocations_quote_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_presale_allocations
    ADD CONSTRAINT battlecity_presale_allocations_quote_id_key UNIQUE (quote_id);


--
-- Name: battlecity_presale_quotes battlecity_presale_quotes_consumed_signature_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_presale_quotes
    ADD CONSTRAINT battlecity_presale_quotes_consumed_signature_key UNIQUE (consumed_signature);


--
-- Name: battlecity_presale_quotes battlecity_presale_quotes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_presale_quotes
    ADD CONSTRAINT battlecity_presale_quotes_pkey PRIMARY KEY (quote_id);


--
-- Name: battlecity_players battlecity_provider_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.battlecity_players
    ADD CONSTRAINT battlecity_provider_check CHECK ((provider = ANY (ARRAY['guest'::text, 'wallet'::text]))) NOT VALID;


--
-- Name: battlecity_push_devices battlecity_push_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_push_devices
    ADD CONSTRAINT battlecity_push_devices_pkey PRIMARY KEY (token);


--
-- Name: battlecity_quest_progress battlecity_quest_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_quest_progress
    ADD CONSTRAINT battlecity_quest_progress_pkey PRIMARY KEY (player_id, quest_id);


--
-- Name: battlecity_ranking_payouts battlecity_ranking_payouts_period_id_player_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_ranking_payouts
    ADD CONSTRAINT battlecity_ranking_payouts_period_id_player_id_key UNIQUE (period_id, player_id);


--
-- Name: battlecity_ranking_payouts battlecity_ranking_payouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_ranking_payouts
    ADD CONSTRAINT battlecity_ranking_payouts_pkey PRIMARY KEY (id);


--
-- Name: battlecity_ranking_periods battlecity_ranking_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_ranking_periods
    ADD CONSTRAINT battlecity_ranking_periods_pkey PRIMARY KEY (id);


--
-- Name: battlecity_replays battlecity_replay_values_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.battlecity_replays
    ADD CONSTRAINT battlecity_replay_values_check CHECK (((level_number >= 1) AND (score >= 0) AND (kills >= 0) AND (duration_ticks >= 0) AND (game_result = ANY (ARRAY['win'::text, 'loss'::text])) AND (validation_status = ANY (ARRAY['pending'::text, 'verified'::text, 'rejected'::text])))) NOT VALID;


--
-- Name: battlecity_replays battlecity_replays_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_replays
    ADD CONSTRAINT battlecity_replays_pkey PRIMARY KEY (id);


--
-- Name: battlecity_schema_migrations battlecity_schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_schema_migrations
    ADD CONSTRAINT battlecity_schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: battlecity_season_passes battlecity_season_passes_payment_signature_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_season_passes
    ADD CONSTRAINT battlecity_season_passes_payment_signature_key UNIQUE (payment_signature);


--
-- Name: battlecity_season_passes battlecity_season_passes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_season_passes
    ADD CONSTRAINT battlecity_season_passes_pkey PRIMARY KEY (player_id, season_id);


--
-- Name: battlecity_seasons battlecity_seasons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_seasons
    ADD CONSTRAINT battlecity_seasons_pkey PRIMARY KEY (id);


--
-- Name: battlecity_sessions battlecity_session_provider_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.battlecity_sessions
    ADD CONSTRAINT battlecity_session_provider_check CHECK ((provider = ANY (ARRAY['guest'::text, 'wallet'::text]))) NOT VALID;


--
-- Name: battlecity_sessions battlecity_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_sessions
    ADD CONSTRAINT battlecity_sessions_pkey PRIMARY KEY (id);


--
-- Name: battlecity_shop_payments battlecity_shop_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_shop_payments
    ADD CONSTRAINT battlecity_shop_payments_pkey PRIMARY KEY (signature);


--
-- Name: battlecity_shop_payments battlecity_shop_payments_quote_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_shop_payments
    ADD CONSTRAINT battlecity_shop_payments_quote_id_key UNIQUE (quote_id);


--
-- Name: battlecity_single_player_sessions battlecity_single_player_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_single_player_sessions
    ADD CONSTRAINT battlecity_single_player_sessions_pkey PRIMARY KEY (id);


--
-- Name: battlecity_site_presence battlecity_site_presence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_site_presence
    ADD CONSTRAINT battlecity_site_presence_pkey PRIMARY KEY (visitor_id, client_id);


--
-- Name: battlecity_site_settings battlecity_site_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_site_settings
    ADD CONSTRAINT battlecity_site_settings_pkey PRIMARY KEY (setting_key);


--
-- Name: battlecity_staking_state battlecity_staking_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_staking_state
    ADD CONSTRAINT battlecity_staking_state_pkey PRIMARY KEY (id);


--
-- Name: battlecity_swap_executions battlecity_swap_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_swap_executions
    ADD CONSTRAINT battlecity_swap_executions_pkey PRIMARY KEY (signature);


--
-- Name: battlecity_swap_executions battlecity_swap_executions_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_swap_executions
    ADD CONSTRAINT battlecity_swap_executions_request_id_key UNIQUE (request_id);


--
-- Name: battlecity_tournament_prize_distributions battlecity_tournament_prize_distrib_tournament_id_player_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_tournament_prize_distributions
    ADD CONSTRAINT battlecity_tournament_prize_distrib_tournament_id_player_id_key UNIQUE (tournament_id, player_id);


--
-- Name: battlecity_tournament_prize_distributions battlecity_tournament_prize_distributions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_tournament_prize_distributions
    ADD CONSTRAINT battlecity_tournament_prize_distributions_pkey PRIMARY KEY (id);


--
-- Name: battlecity_tournaments battlecity_tournaments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_tournaments
    ADD CONSTRAINT battlecity_tournaments_pkey PRIMARY KEY (id);


--
-- Name: battlecity_tournaments battlecity_tournaments_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_tournaments
    ADD CONSTRAINT battlecity_tournaments_slug_key UNIQUE (slug);


--
-- Name: battlecity_trading_volume battlecity_trading_volume_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_trading_volume
    ADD CONSTRAINT battlecity_trading_volume_pkey PRIMARY KEY (signature);


--
-- Name: battlecity_wallet_challenges battlecity_wallet_challenges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_wallet_challenges
    ADD CONSTRAINT battlecity_wallet_challenges_pkey PRIMARY KEY (nonce);


--
-- Name: battlecity_webrtc_observers battlecity_webrtc_observers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_webrtc_observers
    ADD CONSTRAINT battlecity_webrtc_observers_pkey PRIMARY KEY (match_id, observer_id);


--
-- Name: battlecity_webrtc_signals battlecity_webrtc_signal_route_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.battlecity_webrtc_signals
    ADD CONSTRAINT battlecity_webrtc_signal_route_check CHECK (((player_index = ANY (ARRAY[0, 1])) AND (kind = ANY (ARRAY['offer'::text, 'answer'::text])))) NOT VALID;


--
-- Name: battlecity_webrtc_signals battlecity_webrtc_signals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_webrtc_signals
    ADD CONSTRAINT battlecity_webrtc_signals_pkey PRIMARY KEY (revision);


--
-- Name: battlecity_x_comment_claims battlecity_x_comment_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_x_comment_claims
    ADD CONSTRAINT battlecity_x_comment_claims_pkey PRIMARY KEY (task_id, player_id);


--
-- Name: battlecity_x_comment_tasks battlecity_x_comment_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_x_comment_tasks
    ADD CONSTRAINT battlecity_x_comment_tasks_pkey PRIMARY KEY (id);


--
-- Name: battlecity_x_comment_tasks battlecity_x_comment_tasks_post_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_x_comment_tasks
    ADD CONSTRAINT battlecity_x_comment_tasks_post_id_key UNIQUE (post_id);


--
-- Name: battlecity_x_connections battlecity_x_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_x_connections
    ADD CONSTRAINT battlecity_x_connections_pkey PRIMARY KEY (player_id);


--
-- Name: battlecity_x_connections battlecity_x_connections_x_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_x_connections
    ADD CONSTRAINT battlecity_x_connections_x_user_id_key UNIQUE (x_user_id);


--
-- Name: battlecity_x_follow_rewards battlecity_x_follow_rewards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_x_follow_rewards
    ADD CONSTRAINT battlecity_x_follow_rewards_pkey PRIMARY KEY (player_id);


--
-- Name: battlecity_x_repost_claims battlecity_x_repost_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_x_repost_claims
    ADD CONSTRAINT battlecity_x_repost_claims_pkey PRIMARY KEY (task_id, player_id);


--
-- Name: battlecity_x_repost_tasks battlecity_x_repost_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_x_repost_tasks
    ADD CONSTRAINT battlecity_x_repost_tasks_pkey PRIMARY KEY (id);


--
-- Name: battlecity_x_repost_tasks battlecity_x_repost_tasks_post_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_x_repost_tasks
    ADD CONSTRAINT battlecity_x_repost_tasks_post_id_key UNIQUE (post_id);


--
-- Name: battlecity_batc_powerup_drops_player_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_batc_powerup_drops_player_created_idx ON public.battlecity_batc_powerup_drops USING btree (player_id, created_at DESC);


--
-- Name: battlecity_batc_powerup_drops_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_batc_powerup_drops_status_created_idx ON public.battlecity_batc_powerup_drops USING btree (status, created_at DESC);


--
-- Name: battlecity_discord_verifications_code_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_discord_verifications_code_expiry_idx ON public.battlecity_discord_verifications USING btree (code_expires_at) WHERE (code_hash IS NOT NULL);


--
-- Name: battlecity_economy_accounts_provider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_economy_accounts_provider_idx ON public.battlecity_economy_accounts USING btree (provider, updated_at DESC);


--
-- Name: battlecity_event_currency_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_event_currency_event_idx ON public.battlecity_event_currency_balances USING btree (event_id, currency, amount DESC);


--
-- Name: battlecity_ledger_entries_player_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_ledger_entries_player_idx ON public.battlecity_ledger_entries USING btree (player_id, created_at DESC);


--
-- Name: battlecity_ledger_entries_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_ledger_entries_source_idx ON public.battlecity_ledger_entries USING btree (source_type, source_id);


--
-- Name: battlecity_match_archive_batches_match_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_match_archive_batches_match_idx ON public.battlecity_match_archive_batches USING btree (match_id, start_seq);


--
-- Name: battlecity_match_archives_completed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_match_archives_completed_idx ON public.battlecity_match_archives USING btree (completed_at DESC, started_at DESC) WHERE (status = 'completed'::text);


--
-- Name: battlecity_match_results_player_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_match_results_player_idx ON public.battlecity_match_results USING btree (player_id, created_at DESC);


--
-- Name: battlecity_match_results_season_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_match_results_season_idx ON public.battlecity_match_results USING btree (season_id, player_id);


--
-- Name: battlecity_multiplayer_active_slot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX battlecity_multiplayer_active_slot_idx ON public.battlecity_multiplayer_participants USING btree (match_id, player_slot) WHERE (active = true);


--
-- Name: battlecity_multiplayer_event_score_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_multiplayer_event_score_idx ON public.battlecity_multiplayer_scores USING btree (event_id, score DESC) WHERE (validation_status <> 'rejected'::text);


--
-- Name: battlecity_multiplayer_open_match_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_multiplayer_open_match_idx ON public.battlecity_multiplayer_matches USING btree (category, event_id, status, created_at);


--
-- Name: battlecity_multiplayer_player_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_multiplayer_player_idx ON public.battlecity_multiplayer_participants USING btree (player_id, joined_at DESC);


--
-- Name: battlecity_multiplayer_stage_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_multiplayer_stage_queue_idx ON public.battlecity_multiplayer_matches USING btree (category, event_id, current_stage, status, created_at);


--
-- Name: battlecity_native_oauth_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_native_oauth_expiry_idx ON public.battlecity_native_oauth USING btree (expires_at);


--
-- Name: battlecity_players_provider_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_players_provider_created_idx ON public.battlecity_players USING btree (provider, created_at DESC);


--
-- Name: battlecity_presale_allocations_delivery_signature_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX battlecity_presale_allocations_delivery_signature_idx ON public.battlecity_presale_allocations USING btree (delivery_transaction_signature) WHERE (delivery_transaction_signature IS NOT NULL);


--
-- Name: battlecity_presale_allocations_stage_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_presale_allocations_stage_id_idx ON public.battlecity_presale_allocations USING btree (stage_id);


--
-- Name: battlecity_presale_allocations_wallet_address_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_presale_allocations_wallet_address_idx ON public.battlecity_presale_allocations USING btree (wallet_address);


--
-- Name: battlecity_presale_quotes_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_presale_quotes_active_idx ON public.battlecity_presale_quotes USING btree (stage_id, expires_at) WHERE (consumed_signature IS NULL);


--
-- Name: battlecity_push_devices_player_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_push_devices_player_id_idx ON public.battlecity_push_devices USING btree (player_id);


--
-- Name: battlecity_ranking_payouts_history_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_ranking_payouts_history_idx ON public.battlecity_ranking_payouts USING btree (player_id, created_at DESC);


--
-- Name: battlecity_ranking_periods_history_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_ranking_periods_history_idx ON public.battlecity_ranking_periods USING btree (kind, scope, ends_at DESC);


--
-- Name: battlecity_replays_guest_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_replays_guest_created_idx ON public.battlecity_replays USING btree (guest_id, created_at DESC);


--
-- Name: battlecity_replays_player_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_replays_player_created_idx ON public.battlecity_replays USING btree (player_id, created_at DESC);


--
-- Name: battlecity_replays_single_player_session_stage_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_replays_single_player_session_stage_idx ON public.battlecity_replays USING btree (single_player_session_id, level_number);


--
-- Name: battlecity_seasons_number_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX battlecity_seasons_number_uidx ON public.battlecity_seasons USING btree (number);


--
-- Name: battlecity_seasons_window_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_seasons_window_idx ON public.battlecity_seasons USING btree (starts_at, ends_at);


--
-- Name: battlecity_sessions_player_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_sessions_player_idx ON public.battlecity_sessions USING btree (player_id, last_seen_at DESC);


--
-- Name: battlecity_sessions_provider_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_sessions_provider_created_idx ON public.battlecity_sessions USING btree (provider, created_at DESC);


--
-- Name: battlecity_shop_payments_player_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_shop_payments_player_idx ON public.battlecity_shop_payments USING btree (player_id, confirmed_at DESC);


--
-- Name: battlecity_single_player_sessions_guest_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_single_player_sessions_guest_started_idx ON public.battlecity_single_player_sessions USING btree (guest_id, started_at DESC);


--
-- Name: battlecity_single_player_sessions_player_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_single_player_sessions_player_started_idx ON public.battlecity_single_player_sessions USING btree (player_id, started_at DESC);


--
-- Name: battlecity_site_presence_last_seen_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_site_presence_last_seen_idx ON public.battlecity_site_presence USING btree (last_seen_at DESC);


--
-- Name: battlecity_tournament_prizes_tournament_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_tournament_prizes_tournament_idx ON public.battlecity_tournament_prize_distributions USING btree (tournament_id, rank, player_id);


--
-- Name: battlecity_tournaments_status_dates_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_tournaments_status_dates_idx ON public.battlecity_tournaments USING btree (status, starts_at, ends_at);


--
-- Name: battlecity_trading_volume_player_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_trading_volume_player_idx ON public.battlecity_trading_volume USING btree (player_id, created_at DESC);


--
-- Name: battlecity_wallet_challenges_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_wallet_challenges_created_idx ON public.battlecity_wallet_challenges USING btree (created_at DESC);


--
-- Name: battlecity_webrtc_observers_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_webrtc_observers_updated_idx ON public.battlecity_webrtc_observers USING btree (updated_at);


--
-- Name: battlecity_webrtc_signals_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_webrtc_signals_created_idx ON public.battlecity_webrtc_signals USING btree (created_at);


--
-- Name: battlecity_webrtc_signals_latest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX battlecity_webrtc_signals_latest_idx ON public.battlecity_webrtc_signals USING btree (match_id, player_index, kind);


--
-- Name: battlecity_x_comment_one_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX battlecity_x_comment_one_active ON public.battlecity_x_comment_tasks USING btree (active) WHERE active;


--
-- Name: battlecity_x_connections_follow_check_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battlecity_x_connections_follow_check_idx ON public.battlecity_x_connections USING btree (followed_checked_at);


--
-- Name: battlecity_x_repost_one_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX battlecity_x_repost_one_active ON public.battlecity_x_repost_tasks USING btree (active) WHERE active;


--
-- Name: battlecity_batc_powerup_drops battlecity_batc_powerup_drops_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_batc_powerup_drops
    ADD CONSTRAINT battlecity_batc_powerup_drops_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.battlecity_players(id) ON DELETE CASCADE;


--
-- Name: battlecity_discord_follow_rewards battlecity_discord_follow_rewards_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_discord_follow_rewards
    ADD CONSTRAINT battlecity_discord_follow_rewards_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.battlecity_players(id) ON DELETE CASCADE;


--
-- Name: battlecity_economy_accounts battlecity_economy_player_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_economy_accounts
    ADD CONSTRAINT battlecity_economy_player_fk FOREIGN KEY (player_id) REFERENCES public.battlecity_players(id) ON DELETE CASCADE NOT VALID;


--
-- Name: battlecity_match_archive_batches battlecity_match_archive_batch_match_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_match_archive_batches
    ADD CONSTRAINT battlecity_match_archive_batch_match_fk FOREIGN KEY (match_id) REFERENCES public.battlecity_match_archives(match_id) ON DELETE CASCADE;


--
-- Name: battlecity_match_results battlecity_match_player_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_match_results
    ADD CONSTRAINT battlecity_match_player_fk FOREIGN KEY (player_id) REFERENCES public.battlecity_players(id) ON DELETE CASCADE NOT VALID;


--
-- Name: battlecity_match_prize_reviews battlecity_match_prize_reviews_result_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_match_prize_reviews
    ADD CONSTRAINT battlecity_match_prize_reviews_result_id_fkey FOREIGN KEY (result_id) REFERENCES public.battlecity_match_results(id) ON DELETE CASCADE;


--
-- Name: battlecity_match_prize_reviews battlecity_match_prize_reviews_reviewer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_match_prize_reviews
    ADD CONSTRAINT battlecity_match_prize_reviews_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES public.battlecity_players(id);


--
-- Name: battlecity_match_results battlecity_match_season_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_match_results
    ADD CONSTRAINT battlecity_match_season_fk FOREIGN KEY (season_id) REFERENCES public.battlecity_seasons(id) ON DELETE RESTRICT NOT VALID;


--
-- Name: battlecity_multiplayer_event_entries battlecity_multiplayer_event_entry_player_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_multiplayer_event_entries
    ADD CONSTRAINT battlecity_multiplayer_event_entry_player_fk FOREIGN KEY (player_id) REFERENCES public.battlecity_players(id) ON DELETE CASCADE;


--
-- Name: battlecity_multiplayer_participants battlecity_multiplayer_participant_match_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_multiplayer_participants
    ADD CONSTRAINT battlecity_multiplayer_participant_match_fk FOREIGN KEY (match_id) REFERENCES public.battlecity_multiplayer_matches(id) ON DELETE CASCADE;


--
-- Name: battlecity_multiplayer_participants battlecity_multiplayer_participant_player_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_multiplayer_participants
    ADD CONSTRAINT battlecity_multiplayer_participant_player_fk FOREIGN KEY (player_id) REFERENCES public.battlecity_players(id) ON DELETE CASCADE;


--
-- Name: battlecity_multiplayer_scores battlecity_multiplayer_score_match_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_multiplayer_scores
    ADD CONSTRAINT battlecity_multiplayer_score_match_fk FOREIGN KEY (match_id) REFERENCES public.battlecity_multiplayer_matches(id) ON DELETE CASCADE;


--
-- Name: battlecity_multiplayer_scores battlecity_multiplayer_score_player_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_multiplayer_scores
    ADD CONSTRAINT battlecity_multiplayer_score_player_fk FOREIGN KEY (player_id) REFERENCES public.battlecity_players(id) ON DELETE CASCADE;


--
-- Name: battlecity_native_oauth battlecity_native_oauth_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_native_oauth
    ADD CONSTRAINT battlecity_native_oauth_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.battlecity_players(id) ON DELETE CASCADE;


--
-- Name: battlecity_push_devices battlecity_push_devices_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_push_devices
    ADD CONSTRAINT battlecity_push_devices_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.battlecity_players(id) ON DELETE CASCADE;


--
-- Name: battlecity_ranking_payouts battlecity_ranking_payouts_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_ranking_payouts
    ADD CONSTRAINT battlecity_ranking_payouts_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.battlecity_ranking_periods(id);


--
-- Name: battlecity_replays battlecity_replays_single_player_session_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_replays
    ADD CONSTRAINT battlecity_replays_single_player_session_fk FOREIGN KEY (single_player_session_id) REFERENCES public.battlecity_single_player_sessions(id) ON DELETE SET NULL;


--
-- Name: battlecity_season_passes battlecity_season_passes_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_season_passes
    ADD CONSTRAINT battlecity_season_passes_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.battlecity_players(id) ON DELETE CASCADE;


--
-- Name: battlecity_season_passes battlecity_season_passes_season_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_season_passes
    ADD CONSTRAINT battlecity_season_passes_season_id_fkey FOREIGN KEY (season_id) REFERENCES public.battlecity_seasons(id);


--
-- Name: battlecity_sessions battlecity_sessions_player_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_sessions
    ADD CONSTRAINT battlecity_sessions_player_fk FOREIGN KEY (player_id) REFERENCES public.battlecity_players(id) ON DELETE CASCADE NOT VALID;


--
-- Name: battlecity_shop_payments battlecity_shop_payments_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_shop_payments
    ADD CONSTRAINT battlecity_shop_payments_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.battlecity_players(id) ON DELETE CASCADE;


--
-- Name: battlecity_site_presence battlecity_site_presence_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_site_presence
    ADD CONSTRAINT battlecity_site_presence_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.battlecity_players(id) ON DELETE SET NULL;


--
-- Name: battlecity_swap_executions battlecity_swap_executions_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_swap_executions
    ADD CONSTRAINT battlecity_swap_executions_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.battlecity_players(id);


--
-- Name: battlecity_tournaments battlecity_tournament_created_by_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_tournaments
    ADD CONSTRAINT battlecity_tournament_created_by_fk FOREIGN KEY (created_by_player_id) REFERENCES public.battlecity_players(id);


--
-- Name: battlecity_tournaments battlecity_tournament_distributed_by_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_tournaments
    ADD CONSTRAINT battlecity_tournament_distributed_by_fk FOREIGN KEY (prizes_distributed_by_player_id) REFERENCES public.battlecity_players(id);


--
-- Name: battlecity_tournament_prize_distributions battlecity_tournament_prize_admin_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_tournament_prize_distributions
    ADD CONSTRAINT battlecity_tournament_prize_admin_fk FOREIGN KEY (distributed_by_player_id) REFERENCES public.battlecity_players(id);


--
-- Name: battlecity_tournament_prize_distributions battlecity_tournament_prize_player_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_tournament_prize_distributions
    ADD CONSTRAINT battlecity_tournament_prize_player_fk FOREIGN KEY (player_id) REFERENCES public.battlecity_players(id);


--
-- Name: battlecity_tournament_prize_distributions battlecity_tournament_prize_tournament_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_tournament_prize_distributions
    ADD CONSTRAINT battlecity_tournament_prize_tournament_fk FOREIGN KEY (tournament_id) REFERENCES public.battlecity_tournaments(id) ON DELETE CASCADE;


--
-- Name: battlecity_tournaments battlecity_tournament_updated_by_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_tournaments
    ADD CONSTRAINT battlecity_tournament_updated_by_fk FOREIGN KEY (updated_by_player_id) REFERENCES public.battlecity_players(id);


--
-- Name: battlecity_x_comment_claims battlecity_x_comment_claims_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_x_comment_claims
    ADD CONSTRAINT battlecity_x_comment_claims_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.battlecity_players(id) ON DELETE CASCADE;


--
-- Name: battlecity_x_comment_claims battlecity_x_comment_claims_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_x_comment_claims
    ADD CONSTRAINT battlecity_x_comment_claims_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.battlecity_x_comment_tasks(id) ON DELETE CASCADE;


--
-- Name: battlecity_x_comment_tasks battlecity_x_comment_tasks_created_by_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_x_comment_tasks
    ADD CONSTRAINT battlecity_x_comment_tasks_created_by_player_id_fkey FOREIGN KEY (created_by_player_id) REFERENCES public.battlecity_players(id) ON DELETE SET NULL;


--
-- Name: battlecity_x_connections battlecity_x_connections_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_x_connections
    ADD CONSTRAINT battlecity_x_connections_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.battlecity_players(id) ON DELETE CASCADE;


--
-- Name: battlecity_x_follow_rewards battlecity_x_follow_rewards_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_x_follow_rewards
    ADD CONSTRAINT battlecity_x_follow_rewards_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.battlecity_players(id) ON DELETE CASCADE;


--
-- Name: battlecity_x_repost_claims battlecity_x_repost_claims_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_x_repost_claims
    ADD CONSTRAINT battlecity_x_repost_claims_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.battlecity_players(id) ON DELETE CASCADE;


--
-- Name: battlecity_x_repost_claims battlecity_x_repost_claims_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_x_repost_claims
    ADD CONSTRAINT battlecity_x_repost_claims_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.battlecity_x_repost_tasks(id) ON DELETE CASCADE;


--
-- Name: battlecity_x_repost_tasks battlecity_x_repost_tasks_created_by_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battlecity_x_repost_tasks
    ADD CONSTRAINT battlecity_x_repost_tasks_created_by_player_id_fkey FOREIGN KEY (created_by_player_id) REFERENCES public.battlecity_players(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--


