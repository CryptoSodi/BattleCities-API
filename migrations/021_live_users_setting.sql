CREATE TABLE IF NOT EXISTS battlecity_site_settings (
  setting_key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT battlecity_site_settings_key_check
    CHECK (setting_key = 'live_users_enabled')
);

INSERT INTO battlecity_site_settings (setting_key, enabled)
VALUES ('live_users_enabled', FALSE)
ON CONFLICT (setting_key) DO NOTHING;
