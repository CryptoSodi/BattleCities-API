const fs = require('fs').promises;
const path = require('path');
const database = require('../database');
const storageConfig = require('../config/storageConfig');

const TABLE_NAME = 'battlecity_push_devices';

function getFilePath() {
  return process.env.BATTLECITY_PUSH_DEVICE_FILE ||
    path.join(process.cwd(), 'server-data', 'push-devices.json');
}

function hasPersistentConfig() {
  return storageConfig.hasDatabaseConfig();
}

async function upsertDevice(playerId, input) {
  const now = new Date().toISOString();
  const record = {
    token: input.token,
    playerId: typeof playerId === 'string' && playerId.trim() !== '' ? playerId : null,
    platform: input.platform,
    permission: input.permission,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  };

  if (hasPersistentConfig()) {
    await database.assertMigrationsApplied();
    await database.getPool().query(
      `
        INSERT INTO ${TABLE_NAME}
          (token, player_id, platform, permission_state, created_at, updated_at, last_seen_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (token) DO UPDATE SET
          player_id = EXCLUDED.player_id,
          platform = EXCLUDED.platform,
          permission_state = EXCLUDED.permission_state,
          updated_at = EXCLUDED.updated_at,
          last_seen_at = EXCLUDED.last_seen_at
      `,
      [
        record.token,
        record.playerId,
        record.platform,
        record.permission,
        record.createdAt,
        record.updatedAt,
        record.lastSeenAt,
      ],
    );
    return record;
  }

  const records = await readLocalRecords();
  const index = records.findIndex((candidate) => candidate.token === record.token);
  if (index >= 0) {
    record.createdAt = records[index].createdAt || now;
    records[index] = record;
  } else {
    records.push(record);
  }
  await fs.mkdir(path.dirname(getFilePath()), { recursive: true });
  await fs.writeFile(getFilePath(), JSON.stringify(records), 'utf8');
  return record;
}

async function readLocalRecords() {
  try {
    const raw = await fs.readFile(getFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function listGrantedDevices(playerId) {
  const hasPlayerFilter = typeof playerId === 'string' && playerId.trim() !== '';
  if (hasPersistentConfig()) {
    await database.assertMigrationsApplied();
    const result = await database.getPool().query(
      `
        SELECT token, platform
        FROM ${TABLE_NAME}
        WHERE permission_state = 'granted'
          ${hasPlayerFilter ? 'AND player_id = $1' : ''}
        ORDER BY updated_at DESC
      `,
      hasPlayerFilter ? [playerId] : [],
    );
    return result.rows.map((row) => ({ token: row.token, platform: row.platform }));
  }

  const records = await readLocalRecords();
  return records
    .filter((record) =>
      record.permission === 'granted' && (!hasPlayerFilter || record.playerId === playerId),
    )
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .map((record) => ({ token: record.token, platform: record.platform }));
}

async function getGrantedDeviceCount() {
  if (hasPersistentConfig()) {
    await database.assertMigrationsApplied();
    const result = await database.getPool().query(
      `SELECT COUNT(*)::int AS count FROM ${TABLE_NAME} WHERE permission_state = 'granted'`,
    );
    return Number(result.rows[0]?.count || 0);
  }

  return (await readLocalRecords()).filter((record) => record.permission === 'granted').length;
}

module.exports = { upsertDevice, listGrantedDevices, getGrantedDeviceCount };
