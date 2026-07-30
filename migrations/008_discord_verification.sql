CREATE TABLE IF NOT EXISTS battlecity_discord_verifications (
  player_id TEXT PRIMARY KEY,
  discord_user_id TEXT UNIQUE NULL,
  discord_username TEXT NULL,
  code_hash TEXT UNIQUE NULL,
  code_expires_at TIMESTAMPTZ NULL,
  verified_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS battlecity_discord_verifications_code_expiry_idx
  ON battlecity_discord_verifications (code_expires_at)
  WHERE code_hash IS NOT NULL;
