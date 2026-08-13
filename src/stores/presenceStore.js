const fs = require('fs').promises;
const path = require('path');
const storageConfig = require('../config/storageConfig');
const database = require('../database');

const TABLE_NAME = 'battlecity_player_presence';
const PRESENCE_WINDOW_SECONDS = 90;

function getFilePath() {
  return (
    process.env.BATTLECITY_PRESENCE_FILE ||
    path.join(process.cwd(), 'server-data', 'presence.json')
  );
}

function hasPersistentConfig() {
  return storageConfig.hasDatabaseConfig();
}

function getPgPool() {
  return database.getPool();
}

async function ensureSchema() {
  await database.assertMigrationsApplied();
}

async function recordPresence(playerId, input = {}) {
  if (!isValidPlayerId(playerId)) {
    throw new Error('Invalid player ID');
  }

  const inGame = input.inGame === true;
  const gameMode = inGame ? normalizeGameMode(input.gameMode) : null;
  const lastSeenAt = new Date().toISOString();

  if (hasPersistentConfig()) {
    await ensureSchema();
    await getPgPool().query(
      `
        INSERT INTO ${TABLE_NAME} (player_id, in_game, game_mode, last_seen_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (player_id) DO UPDATE SET
          in_game = EXCLUDED.in_game,
          game_mode = EXCLUDED.game_mode,
          last_seen_at = EXCLUDED.last_seen_at
      `,
      [playerId, inGame, gameMode, lastSeenAt],
    );
    return;
  }

  const records = await readLocalRecords();
  records[playerId] = { playerId, inGame, gameMode, lastSeenAt };
  await writeLocalRecords(records);
}

async function removePresence(playerId) {
  if (!isValidPlayerId(playerId)) {
    return;
  }

  if (hasPersistentConfig()) {
    await ensureSchema();
    await getPgPool().query(`DELETE FROM ${TABLE_NAME} WHERE player_id = $1`, [
      playerId,
    ]);
    return;
  }

  const records = await readLocalRecords();
  delete records[playerId];
  await writeLocalRecords(records);
}

async function getCounts() {
  const cutoff = new Date(
    Date.now() - PRESENCE_WINDOW_SECONDS * 1000,
  ).toISOString();

  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `
        SELECT
          COUNT(*)::INTEGER AS online,
          COUNT(*) FILTER (WHERE in_game)::INTEGER AS in_game
        FROM ${TABLE_NAME}
        WHERE last_seen_at >= $1
      `,
      [cutoff],
    );
    return {
      online: Number(result.rows[0]?.online || 0),
      inGame: Number(result.rows[0]?.in_game || 0),
      windowSeconds: PRESENCE_WINDOW_SECONDS,
    };
  }

  const records = await readLocalRecords();
  const active = Object.values(records).filter((record) => {
    return Date.parse(record.lastSeenAt) >= Date.parse(cutoff);
  });
  return {
    online: active.length,
    inGame: active.filter((record) => record.inGame === true).length,
    windowSeconds: PRESENCE_WINDOW_SECONDS,
  };
}

async function readLocalRecords() {
  try {
    const parsed = JSON.parse(await fs.readFile(getFilePath(), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function writeLocalRecords(records) {
  await fs.mkdir(path.dirname(getFilePath()), { recursive: true });
  await fs.writeFile(getFilePath(), JSON.stringify(records), 'utf8');
}

function normalizeGameMode(value) {
  return value === 'multiplayer' ? 'multiplayer' : 'single-player';
}

function isValidPlayerId(value) {
  return typeof value === 'string' && /^ply-[a-z0-9-]+$/i.test(value);
}

module.exports = {
  getCounts,
  recordPresence,
  removePresence,
  PRESENCE_WINDOW_SECONDS,
};
