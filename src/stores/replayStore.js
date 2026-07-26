const fs = require('fs').promises;
const path = require('path');
const storageConfig = require('../config/storageConfig');
const database = require('../database');

const MAX_REPLAYS_PER_GUEST = 50;
const TABLE_NAME = 'battlecity_replays';
const VALID_MATCH_STATUSES = ['pending', 'verified', 'rejected'];
const VALID_GAME_RESULTS = ['win', 'loss'];

let blobClient = null;

function getDataDir() {
  return (
    process.env.BATTLECITY_REPLAY_DIR ||
    path.join(process.cwd(), 'server-data', 'replays')
  );
}

function hasPersistentConfig() {
  const hasBlobConfig =
    String(process.env.BLOB_READ_WRITE_TOKEN || '').trim() !== '';
  if (storageConfig.isProductionRuntime() && !hasBlobConfig) {
    throw new Error('BLOB_READ_WRITE_TOKEN is required in production');
  }
  return storageConfig.hasDatabaseConfig() && hasBlobConfig;
}

function getPgPool() {
  return database.getPool();
}

function getBlobClient() {
  if (blobClient !== null) {
    return blobClient;
  }

  blobClient = require('@vercel/blob');
  return blobClient;
}

async function ensureSchema() {
  await database.assertMigrationsApplied();
}

async function ensureDataDir() {
  await fs.mkdir(getDataDir(), { recursive: true });
}

function getRecordPath(id) {
  return path.join(getDataDir(), `${id}.json`);
}

async function listSummaries(guestId) {
  if (hasPersistentConfig()) {
    return listPersistentSummaries(guestId);
  }

  return listFileSummaries(guestId);
}

async function readRecord(id, guestId) {
  if (!isSafeId(id) || !isValidGuestId(guestId)) {
    return null;
  }

  if (hasPersistentConfig()) {
    return readPersistentRecord(id, guestId);
  }

  return readFileRecord(id, guestId);
}

async function createRecord(guestId, replay) {
  normalizeReplay(replay);
  const metadata = normalizeMetadata(replay.metadata);

  const record = {
    id: createReplayId(),
    guestId,
    createdAt: new Date().toISOString(),
    levelNumber: replay.levelNumber,
    score: metadata.score,
    kills: metadata.kills,
    gameResult: metadata.gameResult,
    durationTicks: metadata.durationTicks,
    replay,
    validationStatus: 'pending',
  };

  if (hasPersistentConfig()) {
    const createdRecord = await createPersistentRecord(record);
    return verifyRecord(createdRecord.id, createdRecord.guestId) || createdRecord;
  }

  const createdRecord = await createFileRecord(record);
  return verifyRecord(createdRecord.id, createdRecord.guestId) || createdRecord;
}

async function listPersistentSummaries(guestId) {
  await ensureSchema();

  const result = await getPgPool().query(
    `
      SELECT id, created_at, level_number, score, kills, game_result,
        duration_ticks, validation_status
      FROM ${TABLE_NAME}
      WHERE guest_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [guestId, MAX_REPLAYS_PER_GUEST],
  );

  return result.rows.map((row) => ({
    id: row.id,
    createdAt: new Date(row.created_at).toISOString(),
    levelNumber: row.level_number,
    score: row.score,
    kills: row.kills,
    gameResult: row.game_result,
    durationTicks: row.duration_ticks,
    validationStatus: row.validation_status,
  }));
}

// Admin/worker read: fetch a replay record by id WITHOUT guest scoping. Used
// only by server-side validation (scripts/validate-results.js) — never expose
// through a client-facing endpoint. In Postgres mode only the metadata row is
// returned (replay: null) — the cross-checks don't need the input blob.
async function readRecordAdmin(id) {
  if (!isSafeId(id)) {
    return null;
  }

  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `
        SELECT id, guest_id, created_at, level_number, score, kills,
          game_result, duration_ticks, validation_status
        FROM ${TABLE_NAME}
        WHERE id = $1
        LIMIT 1
      `,
      [id],
    );

    if (result.rowCount === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id,
      guestId: row.guest_id,
      createdAt: new Date(row.created_at).toISOString(),
      levelNumber: row.level_number,
      score: row.score,
      kills: row.kills,
      gameResult: row.game_result,
      durationTicks: row.duration_ticks,
      validationStatus: row.validation_status,
      replay: null,
    };
  }

  try {
    const raw = await fs.readFile(getRecordPath(id), 'utf8');
    const record = JSON.parse(raw);
    return isValidRecord(record) ? record : null;
  } catch {
    return null;
  }
}

async function readPersistentRecord(id, guestId) {
  await ensureSchema();

  const result = await getPgPool().query(
    `
      SELECT id, guest_id, created_at, level_number, score, kills,
        game_result, duration_ticks, replay_blob_path, validation_status
      FROM ${TABLE_NAME}
      WHERE id = $1
        AND guest_id = $2
      LIMIT 1
    `,
    [id, guestId],
  );

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  const replay = await readReplayBlob(row.replay_blob_path);
  if (!isValidReplay(replay)) {
    return null;
  }

  return {
    id: row.id,
    guestId: row.guest_id,
    createdAt: new Date(row.created_at).toISOString(),
    levelNumber: row.level_number,
    score: row.score,
    kills: row.kills,
    gameResult: row.game_result,
    durationTicks: row.duration_ticks,
    validationStatus: row.validation_status,
    replay,
  };
}

async function createPersistentRecord(record) {
  await ensureSchema();

  const blobPath = `replays/${record.guestId}/${record.id}.json`;
  const blob = await getBlobClient().put(
    blobPath,
    JSON.stringify(record.replay),
    {
      access: 'private',
      addRandomSuffix: false,
      contentType: 'application/json',
    },
  );

  await getPgPool().query(
    `
      INSERT INTO ${TABLE_NAME}
        (id, guest_id, created_at, level_number, replay_blob_path,
          score, kills, game_result, duration_ticks, replay_blob_url,
          validation_status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `,
    [
      record.id,
      record.guestId,
      record.createdAt,
      record.levelNumber,
      blobPath,
      record.score,
      record.kills,
      record.gameResult,
      record.durationTicks,
      blob.url,
      record.validationStatus,
    ],
  );

  await prunePersistentRecords(record.guestId);

  return record;
}

async function updatePersistentValidationStatus(id, guestId, validationStatus) {
  await ensureSchema();

  const result = await getPgPool().query(
    `
      UPDATE ${TABLE_NAME}
      SET validation_status = $3
      WHERE id = $1
        AND guest_id = $2
      RETURNING id, guest_id, created_at, level_number, score, kills,
        game_result, duration_ticks, replay_blob_path, validation_status
    `,
    [id, guestId, validationStatus],
  );

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  const replay = await readReplayBlob(row.replay_blob_path);
  if (!isValidReplay(replay)) {
    return null;
  }

  return {
    id: row.id,
    guestId: row.guest_id,
    createdAt: new Date(row.created_at).toISOString(),
    levelNumber: row.level_number,
    score: row.score,
    kills: row.kills,
    gameResult: row.game_result,
    durationTicks: row.duration_ticks,
    validationStatus: row.validation_status,
    replay,
  };
}

async function readReplayBlob(pathname) {
  const { get } = getBlobClient();
  const result = await get(pathname, { access: 'private' });

  if (result?.statusCode !== 200 || result.stream === null) {
    return null;
  }

  return new Response(result.stream).json();
}

async function prunePersistentRecords(guestId) {
  const result = await getPgPool().query(
    `
      SELECT id, replay_blob_path
      FROM ${TABLE_NAME}
      WHERE guest_id = $1
      ORDER BY created_at DESC
      OFFSET $2
    `,
    [guestId, MAX_REPLAYS_PER_GUEST],
  );

  if (result.rowCount === 0) {
    return;
  }

  await getPgPool().query(
    `DELETE FROM ${TABLE_NAME} WHERE id = ANY($1::text[])`,
    [result.rows.map((row) => row.id)],
  );

  const { del } = getBlobClient();
  await Promise.all(
    result.rows.map((row) => del(row.replay_blob_path).catch(() => undefined)),
  );
}

async function listFileRecords() {
  await ensureDataDir();

  const files = await fs.readdir(getDataDir());
  const records = await Promise.all(
    files
      .filter((file) => file.endsWith('.json'))
      .map(async (file) => {
        try {
          const raw = await fs.readFile(path.join(getDataDir(), file), 'utf8');
          const record = JSON.parse(raw);
          return isValidRecord(record) ? record : null;
        } catch {
          return null;
        }
      }),
  );

  return records.filter((record) => record !== null);
}

async function listFileSummaries(guestId) {
  const records = await listFileRecords();

  return records
    .filter((record) => record.guestId === guestId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_REPLAYS_PER_GUEST)
    .map(toSummary);
}

async function readFileRecord(id, guestId) {
  try {
    const raw = await fs.readFile(getRecordPath(id), 'utf8');
    const record = JSON.parse(raw);
    if (!isValidRecord(record) || record.guestId !== guestId) {
      return null;
    }

    return record;
  } catch {
    return null;
  }
}

async function createFileRecord(record) {
  await ensureDataDir();
  await fs.writeFile(getRecordPath(record.id), JSON.stringify(record), 'utf8');
  await pruneFileRecords(record.guestId);

  return record;
}

async function updateFileValidationStatus(id, guestId, validationStatus) {
  try {
    const raw = await fs.readFile(getRecordPath(id), 'utf8');
    const record = JSON.parse(raw);
    if (!isValidRecord(record) || record.guestId !== guestId) {
      return null;
    }

    record.validationStatus = validationStatus;
    await fs.writeFile(getRecordPath(id), JSON.stringify(record), 'utf8');

    return record;
  } catch {
    return null;
  }
}

async function pruneFileRecords(guestId) {
  const records = (await listFileRecords())
    .filter((record) => record.guestId === guestId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  await Promise.all(
    records.slice(MAX_REPLAYS_PER_GUEST).map((record) => {
      return fs.unlink(getRecordPath(record.id)).catch(() => undefined);
    }),
  );
}

function toSummary(record) {
  return {
    id: record.id,
    createdAt: record.createdAt,
    levelNumber: record.levelNumber,
    score: record.score || 0,
    kills: record.kills || 0,
    gameResult: record.gameResult || 'loss',
    durationTicks: record.durationTicks || 0,
    matchStatus: record.validationStatus || 'pending',
  };
}

async function verifyRecord(id, guestId) {
  const record = await readRecord(id, guestId);
  if (record === null) {
    return null;
  }

  const validationStatus = getValidationStatus(record);

  if (hasPersistentConfig()) {
    return updatePersistentValidationStatus(id, guestId, validationStatus);
  }

  return updateFileValidationStatus(id, guestId, validationStatus);
}

function createReplayId() {
  return `${Date.now().toString(36)}-${Math.floor(
    Math.random() * 0xffffff,
  ).toString(36)}`;
}

function isValidGuestId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 96;
}

function isSafeId(value) {
  return typeof value === 'string' && /^[a-z0-9-]+$/i.test(value);
}

function isValidRecord(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    isSafeId(value.id) &&
    isValidGuestId(value.guestId) &&
    typeof value.createdAt === 'string' &&
    typeof value.levelNumber === 'number' &&
    typeof value.score === 'number' &&
    typeof value.kills === 'number' &&
    isValidGameResult(value.gameResult) &&
    typeof value.durationTicks === 'number' &&
    isValidMatchStatus(value.validationStatus) &&
    isValidReplay(value.replay)
  );
}

function isValidReplay(value) {
  normalizeReplay(value);

  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.seed === 'number' &&
    typeof value.levelNumber === 'number' &&
    typeof value.deviceFrames === 'object' &&
    value.deviceFrames !== null &&
    typeof value.activeDeviceType === 'number' &&
    typeof value.enemyTraces === 'object' &&
    value.enemyTraces !== null &&
    typeof value.runConsumables === 'object' &&
    value.runConsumables !== null &&
    Array.isArray(value.runConsumables.powerups) &&
    Array.isArray(value.runConsumables.powerupItems) &&
    Array.isArray(value.runConsumables.powerupCounts) &&
    typeof value.runConsumables.extraLives === 'number' &&
    typeof value.metadata === 'object' &&
    value.metadata !== null &&
    isValidMatchStatus(value.metadata.matchStatus) &&
    typeof value.metadata.score === 'number' &&
    typeof value.metadata.kills === 'number' &&
    isValidGameResult(value.metadata.gameResult) &&
    typeof value.metadata.durationTicks === 'number' &&
    Array.isArray(value.powerupSpawns)
  );
}

function getValidationStatus(record) {
  if (!isValidRecord(record)) {
    return 'rejected';
  }

  const replayMetadata = record.replay.metadata;
  if (!isValidReplayMetadata(replayMetadata)) {
    return 'rejected';
  }

  const replayMatchesRecord =
    record.levelNumber === record.replay.levelNumber &&
    record.score === replayMetadata.score &&
    record.kills === replayMetadata.kills &&
    record.gameResult === replayMetadata.gameResult &&
    record.durationTicks === replayMetadata.durationTicks &&
    replayMetadata.matchStatus === 'pending';

  return replayMatchesRecord ? 'verified' : 'rejected';
}

function normalizeReplay(value) {
  if (typeof value !== 'object' || value === null) {
    return;
  }

  if (value.runConsumables === undefined) {
    value.runConsumables = {
      powerups: [],
      powerupItems: [],
      powerupCounts: [],
      extraLives: 0,
    };
  }

  if (
    typeof value.runConsumables === 'object' &&
    value.runConsumables !== null &&
    value.runConsumables.powerupCounts === undefined &&
    Array.isArray(value.runConsumables.powerupItems)
  ) {
    value.runConsumables.powerupCounts = value.runConsumables.powerupItems.map(
      () => 1,
    );
  }

  if (value.metadata === undefined) {
    value.metadata = normalizeMetadata(null);
  } else {
    value.metadata = normalizeMetadata(value.metadata);
  }
}

function normalizeMetadata(value) {
  const metadata = typeof value === 'object' && value !== null ? value : {};

  return {
    matchStatus: isValidMatchStatus(metadata.matchStatus)
      ? metadata.matchStatus
      : 'pending',
    score: normalizeNonNegativeInteger(metadata.score, 0),
    kills: normalizeNonNegativeInteger(metadata.kills, 0),
    gameResult: isValidGameResult(metadata.gameResult)
      ? metadata.gameResult
      : 'loss',
    durationTicks: normalizeNonNegativeInteger(metadata.durationTicks, 0),
  };
}

function isValidReplayMetadata(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    isValidMatchStatus(value.matchStatus) &&
    typeof value.score === 'number' &&
    typeof value.kills === 'number' &&
    isValidGameResult(value.gameResult) &&
    typeof value.durationTicks === 'number'
  );
}

function normalizeNonNegativeInteger(value, defaultValue) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : defaultValue;
}

function isValidMatchStatus(value) {
  return VALID_MATCH_STATUSES.indexOf(value) !== -1;
}

function isValidGameResult(value) {
  return VALID_GAME_RESULTS.indexOf(value) !== -1;
}

module.exports = {
  createRecord,
  isPersistentStoreConfigured: hasPersistentConfig,
  isValidGuestId,
  isValidReplay,
  listSummaries,
  readRecord,
  readRecordAdmin,
  verifyRecord,
  toSummary,
};
