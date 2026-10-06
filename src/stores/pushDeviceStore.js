const fs = require('fs').promises;
const path = require('path');
const { randomUUID } = require('crypto');
const database = require('../database');
const storageConfig = require('../config/storageConfig');

const TABLE_NAME = 'battlecity_push_devices';
let localWrites = Promise.resolve();

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
    const result = await database.getPool().query(
      `
        INSERT INTO ${TABLE_NAME}
          (token, player_id, platform, permission_state, created_at, updated_at, last_seen_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (token) DO UPDATE SET
          player_id = EXCLUDED.player_id,
          platform = EXCLUDED.platform,
          permission_state = EXCLUDED.permission_state,
          updated_at = GREATEST(EXCLUDED.updated_at, ${TABLE_NAME}.updated_at + INTERVAL '1 millisecond'),
          last_seen_at = GREATEST(EXCLUDED.last_seen_at, ${TABLE_NAME}.last_seen_at + INTERVAL '1 millisecond')
        RETURNING created_at, updated_at, last_seen_at
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
    record.createdAt = new Date(result.rows[0].created_at).toISOString();
    record.updatedAt = new Date(result.rows[0].updated_at).toISOString();
    record.lastSeenAt = new Date(result.rows[0].last_seen_at).toISOString();
    return record;
  }

  return writeLocalRecords((records) => {
    const index = records.findIndex((candidate) => candidate.token === record.token);
    if (index >= 0) {
      record.createdAt = records[index].createdAt || now;
      const previousTime = Date.parse(records[index].lastSeenAt) || 0;
      record.lastSeenAt = record.updatedAt = new Date(Math.max(Date.now(), previousTime + 1)).toISOString();
      records[index] = record;
    } else {
      records.push(record);
    }
    return record;
  });
}

async function readLocalRecords(file = getFilePath()) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('Invalid local notification device store');
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function writeLocalRecords(update) {
  const file = getFilePath();
  const operation = localWrites.catch(() => {}).then(async () => {
    const records = await readLocalRecords(file);
    const value = update(records);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(records), 'utf8');
      await fs.rename(temporary, file);
    } finally {
      await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
    return value;
  });
  localWrites = operation;
  return operation;
}

async function listGrantedDevices(playerId, token) {
  const hasPlayerFilter = typeof playerId === 'string' && playerId.trim() !== '';
  const hasTokenFilter = typeof token === 'string' && token !== '';
  if (hasPersistentConfig()) {
    await database.assertMigrationsApplied();
    const filters = ["permission_state = 'granted'", "platform = 'android'"];
    const values = [];
    if (hasPlayerFilter) { values.push(playerId); filters.push(`player_id = $${values.length}`); }
    if (hasTokenFilter) { values.push(token); filters.push(`token = $${values.length}`); }
    const result = await database.getPool().query(
      `
        SELECT token, platform, player_id, last_seen_at::text AS last_seen_at
        FROM ${TABLE_NAME}
        WHERE ${filters.join(' AND ')}
        ORDER BY updated_at DESC
      `,
      values,
    );
    return result.rows.map((row) => ({ token: row.token, platform: row.platform,
      playerId: row.player_id, lastSeenAt: row.last_seen_at }));
  }

  const records = await readLocalRecords();
  return records
    .filter((record) =>
      record.permission === 'granted' && record.platform === 'android'
        && (!hasPlayerFilter || record.playerId === playerId) && (!hasTokenFilter || record.token === token),
    )
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .map((record) => ({ token: record.token, platform: record.platform,
      playerId: record.playerId, lastSeenAt: record.lastSeenAt }));
}

async function getGrantedDevice(token, playerId) {
  return (await listGrantedDevices(playerId, token))[0] || null;
}

async function removeInvalidDevice(token, lastSeenAt) {
  if (hasPersistentConfig()) {
    await database.assertMigrationsApplied();
    const result = await database.getPool().query(
      `DELETE FROM ${TABLE_NAME} WHERE token = $1 AND last_seen_at = $2`, [token, lastSeenAt],
    );
    return result.rowCount > 0;
  }
  return writeLocalRecords((records) => {
    const index = records.findIndex((record) => record.token === token && record.lastSeenAt === lastSeenAt);
    if (index < 0) return false;
    records.splice(index, 1);
    return true;
  });
}

async function getGrantedDeviceCount() {
  if (hasPersistentConfig()) {
    await database.assertMigrationsApplied();
    const result = await database.getPool().query(
      `SELECT COUNT(*)::int AS count FROM ${TABLE_NAME} WHERE permission_state = 'granted' AND platform = 'android'`,
    );
    return Number(result.rows[0]?.count || 0);
  }

  return (await readLocalRecords()).filter((record) => record.permission === 'granted' && record.platform === 'android').length;
}

module.exports = { upsertDevice, listGrantedDevices, getGrantedDevice, removeInvalidDevice, getGrantedDeviceCount };
