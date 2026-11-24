-- The activation time prevents existing accounts being treated as new signups.
CREATE TABLE battlecity_referral_program (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO battlecity_referral_program (singleton) VALUES (TRUE);

CREATE TABLE battlecity_referral_profiles (
  player_id TEXT PRIMARY KEY REFERENCES battlecity_players(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-F0-9]{12}$'),
  prompt_dismissed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE battlecity_referrals (
  referred_player_id TEXT PRIMARY KEY REFERENCES battlecity_players(id) ON DELETE CASCADE,
  referrer_player_id TEXT NOT NULL REFERENCES battlecity_players(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (referred_player_id <> referrer_player_id)
);
CREATE INDEX battlecity_referrals_referrer_idx ON battlecity_referrals(referrer_player_id);

-- Atomic units avoid rounding away SOL/token precision. One reward per payment.
CREATE TABLE battlecity_referral_rewards (
  payment_signature TEXT PRIMARY KEY REFERENCES battlecity_shop_payments(signature),
  referrer_player_id TEXT NOT NULL REFERENCES battlecity_players(id),
  referred_player_id TEXT NOT NULL REFERENCES battlecity_players(id),
  currency TEXT NOT NULL CHECK (currency IN ('sol', 'skr', 'play', 'token')),
  network TEXT NOT NULL,
  token_mint TEXT,
  token_program TEXT,
  decimals SMALLINT NOT NULL CHECK (decimals BETWEEN 0 AND 9),
  amount_atomic NUMERIC(30,0) NOT NULL CHECK (amount_atomic >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX battlecity_referral_rewards_referrer_idx ON battlecity_referral_rewards(referrer_player_id, currency);
