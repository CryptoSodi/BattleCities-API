const database = require('../database');
const storageConfig = require('../config/storageConfig');

const LIVE_USERS_KEY = 'live_users_enabled';
let localLiveUsersEnabled = false;

function hasPersistentConfig() {
  return storageConfig.hasDatabaseConfig();
}

async function getLiveUsersEnabled() {
  if (!hasPersistentConfig()) return localLiveUsersEnabled;
  await database.assertMigrationsApplied();
  const result = await database.getPool().query(
    'SELECT enabled FROM battlecity_site_settings WHERE setting_key = $1',
    [LIVE_USERS_KEY],
  );
  return result.rows[0]?.enabled === true;
}

async function setLiveUsersEnabled(enabled) {
  const value = enabled === true;
  if (!hasPersistentConfig()) {
    localLiveUsersEnabled = value;
    return value;
  }
  await database.assertMigrationsApplied();
  const result = await database.getPool().query(
    `INSERT INTO battlecity_site_settings (setting_key, enabled, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (setting_key) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       updated_at = NOW()
     RETURNING enabled`,
    [LIVE_USERS_KEY, value],
  );
  return result.rows[0]?.enabled === true;
}

module.exports = { getLiveUsersEnabled, setLiveUsersEnabled };
