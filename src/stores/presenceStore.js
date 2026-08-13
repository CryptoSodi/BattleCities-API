const fs = require('fs').promises;
const path = require('path');
const storageConfig = require('../config/storageConfig');
const database = require('../database');

const TABLE_NAME = 'battlecity_site_presence';
const PRESENCE_WINDOW_SECONDS = 90;
const STALE_RECORD_SECONDS = 60 * 60 * 24;
let lastPrunedAt = 0;

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

async function recordPresence(visitorId, clientId, input = {}) {
  validateIdentity(visitorId, clientId);

  const playerId = isValidPlayerId(input.playerId) ? input.playerId : null;
  const inGame = playerId !== null && input.inGame === true;
  const gameMode = inGame ? normalizeGameMode(input.gameMode) : null;
  const lastSeenAt = new Date().toISOString();

  if (hasPersistentConfig()) {
    await ensureSchema();
    await prunePersistentRecords();
    await getPgPool().query(
      `
        INSERT INTO ${TABLE_NAME} (
          visitor_id,
          client_id,
          player_id,
          in_game,
          game_mode,
          last_seen_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (visitor_id, client_id) DO UPDATE SET
          player_id = EXCLUDED.player_id,
          in_game = EXCLUDED.in_game,
          game_mode = EXCLUDED.game_mode,
          last_seen_at = EXCLUDED.last_seen_at
      `,
      [visitorId, clientId, playerId, inGame, gameMode, lastSeenAt],
    );
    return;
  }

  const records = await readLocalRecords();
  records[getRecordKey(visitorId, clientId)] = {
    visitorId,
    clientId,
    playerId,
    inGame,
    gameMode,
    lastSeenAt,
  };
  await writeLocalRecords(pruneLocalRecords(records));
}

async function removePresence(visitorId, clientId) {
  if (!isValidVisitorId(visitorId) || !isValidClientId(clientId)) {
    return;
  }

  if (hasPersistentConfig()) {
    await ensureSchema();
    await getPgPool().query(
      `DELETE FROM ${TABLE_NAME} WHERE visitor_id = $1 AND client_id = $2`,
      [visitorId, clientId],
    );
    return;
  }

  const records = await readLocalRecords();
  delete records[getRecordKey(visitorId, clientId)];
  await writeLocalRecords(records);
}

async function getCounts() {
  const cutoff = new Date(
    Date.now() - PRESENCE_WINDOW_SECONDS * 1000,
  ).toISOString();

  if (hasPersistentConfig()) {
    await ensureSchema();
    await prunePersistentRecords();
    const result = await getPgPool().query(
      `
        SELECT
          COUNT(DISTINCT visitor_id)::INTEGER AS online,
          COUNT(DISTINCT visitor_id) FILTER (WHERE in_game)::INTEGER AS in_game
        FROM ${TABLE_NAME}
        WHERE last_seen_at >= $1
      `,
      [cutoff],
    );
    return formatCounts(result.rows[0]?.online, result.rows[0]?.in_game);
  }

  const active = Object.values(await readLocalRecords()).filter((record) => {
    return (
      isValidVisitorId(record.visitorId) &&
      Date.parse(record.lastSeenAt) >= Date.parse(cutoff)
    );
  });
  const onlineVisitors = new Set(active.map((record) => record.visitorId));
  const inGameVisitors = new Set(
    active
      .filter((record) => record.inGame === true)
      .map((record) => record.visitorId),
  );
  return formatCounts(onlineVisitors.size, inGameVisitors.size);
}

async function prunePersistentRecords() {
  const now = Date.now();
  if (now - lastPrunedAt < 60 * 60 * 1000) {
    return;
  }
  lastPrunedAt = now;
  await getPgPool().query(
    `DELETE FROM ${TABLE_NAME} WHERE last_seen_at < NOW() - ($1 * INTERVAL '1 second')`,
    [STALE_RECORD_SECONDS],
  );
}

function pruneLocalRecords(records) {
  const cutoff = Date.now() - STALE_RECORD_SECONDS * 1000;
  return Object.fromEntries(
    Object.entries(records).filter(([, record]) => {
      return Date.parse(record.lastSeenAt) >= cutoff;
    }),
  );
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

function formatCounts(online, inGame) {
  return {
    online: Number(online || 0),
    inGame: Number(inGame || 0),
    windowSeconds: PRESENCE_WINDOW_SECONDS,
  };
}

function normalizeGameMode(value) {
  return value === 'multiplayer' ? 'multiplayer' : 'single-player';
}

function getRecordKey(visitorId, clientId) {
  return `${visitorId}:${clientId}`;
}

function validateIdentity(visitorId, clientId) {
  if (!isValidVisitorId(visitorId)) {
    throw new Error('Invalid visitor ID');
  }
  if (!isValidClientId(clientId)) {
    throw new Error('Invalid presence client ID');
  }
}

function isValidVisitorId(value) {
  return typeof value === 'string' && /^visitor-[a-f0-9]{32}$/.test(value);
}

function isValidClientId(value) {
  return typeof value === 'string' && /^[a-z0-9-]{6,80}$/i.test(value);
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
