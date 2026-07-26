const fs = require('fs').promises;
const path = require('path');
const storageConfig = require('../config/storageConfig');
const database = require('../database');

const TABLE_NAME = 'battlecity_webrtc_signals';
const OBSERVER_TABLE_NAME = 'battlecity_webrtc_observers';
const SIGNAL_TTL_MS = 5 * 60 * 1000;
const OBSERVER_TTL_MS = 20 * 1000;
const MAX_OBSERVERS_PER_MATCH = 32;
const SIGNAL_MAX_BYTES = 256 * 1024;

function getDataDir() {
  return (
    process.env.BATTLECITY_WEBRTC_SIGNAL_DIR ||
    path.join(process.cwd(), 'server-data', 'webrtc-signals')
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

async function cleanupExpired(now = Date.now()) {
  if (hasPersistentConfig()) {
    await ensureSchema();
    await getPgPool().query(
      `DELETE FROM ${TABLE_NAME} WHERE created_at < NOW() - INTERVAL '5 minutes'`,
    );
    await getPgPool().query(
      `DELETE FROM ${OBSERVER_TABLE_NAME} WHERE updated_at < NOW() - INTERVAL '20 seconds'`,
    );
    return;
  }

  await ensureDataDir();
  const files = await fs.readdir(getDataDir());
  await Promise.all(
    files
      .filter((file) => file.endsWith('.json'))
      .map(async (file) => {
        const filePath = path.join(getDataDir(), file);
        try {
          const signal = JSON.parse(await fs.readFile(filePath, 'utf8'));
          const isObserver = file.startsWith('registry-observer-');
          const timestamp = Date.parse(
            isObserver ? signal.updatedAt : signal.createdAt,
          );
          const ttl = isObserver ? OBSERVER_TTL_MS : SIGNAL_TTL_MS;
          if (!Number.isFinite(timestamp) || now - timestamp > ttl) {
            await fs.unlink(filePath);
          }
        } catch {
          await fs.unlink(filePath).catch(() => {});
        }
      }),
  );
}

async function registerObserver(matchId, observerId) {
  validateObserverRoute(matchId, observerId);
  await cleanupExpired();

  if (hasPersistentConfig()) {
    await ensureSchema();
    const existing = await getPgPool().query(
      `SELECT 1 FROM ${OBSERVER_TABLE_NAME} WHERE match_id = $1 AND observer_id = $2`,
      [matchId, observerId],
    );
    if (existing.rowCount === 0) {
      const count = await getPgPool().query(
        `SELECT COUNT(*) AS count FROM ${OBSERVER_TABLE_NAME} WHERE match_id = $1`,
        [matchId],
      );
      if (Number(count.rows[0].count) >= MAX_OBSERVERS_PER_MATCH) {
        throw new Error('Observer limit reached');
      }
    }
    await getPgPool().query(
      `
        INSERT INTO ${OBSERVER_TABLE_NAME} (match_id, observer_id, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (match_id, observer_id)
        DO UPDATE SET updated_at = NOW()
      `,
      [matchId, observerId],
    );
    return;
  }

  await ensureDataDir();
  const observers = await listObservers(matchId);
  if (
    !observers.includes(observerId) &&
    observers.length >= MAX_OBSERVERS_PER_MATCH
  ) {
    throw new Error('Observer limit reached');
  }
  await fs.writeFile(
    getObserverPath(matchId, observerId),
    JSON.stringify({ matchId, observerId, updatedAt: new Date().toISOString() }),
    'utf8',
  );
}

async function listObservers(matchId) {
  if (!isValidMatchId(matchId)) {
    throw new Error('Invalid observer route');
  }
  await cleanupExpired();

  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `SELECT observer_id FROM ${OBSERVER_TABLE_NAME} WHERE match_id = $1 ORDER BY updated_at`,
      [matchId],
    );
    return result.rows.map((row) => row.observer_id);
  }

  await ensureDataDir();
  const prefix = `registry-observer-${safePathPart(matchId)}-`;
  const files = await fs.readdir(getDataDir());
  const observers = await Promise.all(
    files
      .filter((file) => file.startsWith(prefix) && file.endsWith('.json'))
      .map(async (file) => {
        try {
          const entry = JSON.parse(
            await fs.readFile(path.join(getDataDir(), file), 'utf8'),
          );
          return isValidObserverId(entry.observerId) ? entry.observerId : null;
        } catch {
          return null;
        }
      }),
  );
  return observers.filter((observerId) => observerId !== null);
}

async function publishSignal(matchId, playerIndex, kind, code) {
  validateSignalRoute(matchId, playerIndex, kind);
  if (
    typeof code !== 'string' ||
    code.length === 0 ||
    Buffer.byteLength(code, 'utf8') > SIGNAL_MAX_BYTES
  ) {
    throw new Error('Invalid signal code');
  }

  if (hasPersistentConfig()) {
    await ensureSchema();
    await cleanupExpired();
    const result = await getPgPool().query(
      `
        INSERT INTO ${TABLE_NAME}
          (match_id, player_index, kind, code, created_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (match_id, player_index, kind)
        DO UPDATE SET
          code = EXCLUDED.code,
          created_at = NOW(),
          revision = nextval(pg_get_serial_sequence('${TABLE_NAME}', 'revision'))
        RETURNING revision, created_at
      `,
      [matchId, Number(playerIndex), kind, code],
    );
    const row = result.rows[0];
    return {
      id: Number(row.revision),
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  await ensureDataDir();
  await cleanupExpired();
  const createdAt = new Date().toISOString();
  const previous = await readLocalSignal(matchId, playerIndex, kind);
  const id = previous === null ? 1 : previous.id + 1;
  const signal = {
    id,
    matchId,
    playerIndex: Number(playerIndex),
    kind,
    code,
    createdAt,
  };
  await fs.writeFile(
    getSignalPath(matchId, playerIndex, kind),
    JSON.stringify(signal),
    'utf8',
  );
  return { id, createdAt };
}

async function readSignal(matchId, playerIndex, kind, after = 0) {
  validateSignalRoute(matchId, playerIndex, kind);
  const minRevision = Number.isFinite(Number(after)) ? Number(after) : 0;

  if (hasPersistentConfig()) {
    await ensureSchema();
    await cleanupExpired();
    const result = await getPgPool().query(
      `
        SELECT revision, match_id, player_index, kind, code, created_at
        FROM ${TABLE_NAME}
        WHERE match_id = $1
          AND player_index = $2
          AND kind = $3
          AND revision > $4
        LIMIT 1
      `,
      [matchId, Number(playerIndex), kind, minRevision],
    );
    if (result.rowCount === 0) {
      return null;
    }
    return rowToSignal(result.rows[0]);
  }

  await cleanupExpired();
  const signal = await readLocalSignal(matchId, playerIndex, kind);
  if (signal === null || signal.id <= minRevision) {
    return null;
  }
  return signal;
}

async function readLocalSignal(matchId, playerIndex, kind) {
  try {
    return JSON.parse(
      await fs.readFile(getSignalPath(matchId, playerIndex, kind), 'utf8'),
    );
  } catch {
    return null;
  }
}

function rowToSignal(row) {
  return {
    id: Number(row.revision),
    matchId: row.match_id,
    playerIndex: Number(row.player_index),
    kind: row.kind,
    code: row.code,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function ensureDataDir() {
  await fs.mkdir(getDataDir(), { recursive: true });
}

function getSignalPath(matchId, playerIndex, kind) {
  return path.join(getDataDir(), `${safePathPart(matchId)}-${playerIndex}-${kind}.json`);
}

function getObserverPath(matchId, observerId) {
  return path.join(
    getDataDir(),
    `registry-observer-${safePathPart(matchId)}-${safePathPart(observerId)}.json`,
  );
}

function safePathPart(value) {
  return String(value).replace(/[^0-9A-Za-z_-]/g, '_');
}

function validateSignalRoute(matchId, playerIndex, kind) {
  if (
    !isValidMatchId(matchId) ||
    !isValidPlayerIndex(String(playerIndex)) ||
    !isValidSignalKind(kind)
  ) {
    throw new Error('Invalid signal route');
  }
}

function validateObserverRoute(matchId, observerId) {
  if (!isValidMatchId(matchId) || !isValidObserverId(observerId)) {
    throw new Error('Invalid observer route');
  }
}

function isValidMatchId(value) {
  return typeof value === 'string' && /^[0-9A-Za-z_-]{1,64}$/.test(value);
}

function isValidPlayerIndex(value) {
  return value === '0' || value === '1';
}

function isValidObserverId(value) {
  return typeof value === 'string' && /^[0-9a-z]{8}$/.test(value);
}

function isValidSignalKind(value) {
  return value === 'offer' || value === 'answer';
}

module.exports = {
  SIGNAL_MAX_BYTES,
  MAX_OBSERVERS_PER_MATCH,
  isValidMatchId,
  isValidPlayerIndex,
  isValidSignalKind,
  isValidObserverId,
  registerObserver,
  listObservers,
  publishSignal,
  readSignal,
};
