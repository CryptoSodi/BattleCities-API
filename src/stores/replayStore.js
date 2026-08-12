const fs = require('fs').promises;
const path = require('path');
const storageConfig = require('../config/storageConfig');
const database = require('../database');

const MAX_REPLAYS_PER_GUEST = 50;
const TABLE_NAME = 'battlecity_replays';
const VALID_MATCH_STATUSES = ['pending', 'verified', 'rejected'];
const VALID_GAME_RESULTS = ['win', 'loss'];

function getDataDir() {
  return (
    process.env.BATTLECITY_REPLAY_DIR ||
    path.join(process.cwd(), 'server-data', 'replays')
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

async function createRecord(guestId, replay, playerId = null, options = {}) {
  normalizeReplay(replay);
  const metadata = normalizeMetadata(replay.metadata);
  const sessionOptions = normalizeSessionOptions(options);

  const record = {
    id: createReplayId(),
    guestId,
    playerId,
    createdAt: new Date().toISOString(),
    levelNumber: replay.levelNumber,
    score: metadata.score,
    kills: metadata.kills,
    gameResult: metadata.gameResult,
    durationTicks: metadata.durationTicks,
    replay,
    validationStatus: 'pending',
    singlePlayerSessionId: sessionOptions.sessionId,
    session: null,
  };

  if (hasPersistentConfig()) {
    const createdRecord = await createPersistentRecord(record, sessionOptions);
    const verifiedRecord = await verifyRecord(
      createdRecord.id,
      createdRecord.guestId,
    );
    return {
      ...(verifiedRecord || createdRecord),
      session: createdRecord.session,
    };
  }

  record.singlePlayerSessionId =
    sessionOptions.sessionId || createSinglePlayerSessionId();
  record.session = createFileSessionSummary(record, sessionOptions.completeSession);
  const createdRecord = await createFileRecord(record);
  const verifiedRecord = await verifyRecord(createdRecord.id, createdRecord.guestId);
  return {
    ...(verifiedRecord || createdRecord),
    session: createdRecord.session,
  };
}

async function listPersistentSummaries(guestId) {
  await ensureSchema();

  const result = await getPgPool().query(
    `
      SELECT id, player_id, created_at, level_number, score, kills, game_result,
        duration_ticks, validation_status, single_player_session_id
      FROM ${TABLE_NAME}
      WHERE guest_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [guestId, MAX_REPLAYS_PER_GUEST],
  );

  return result.rows.map((row) => ({
    id: row.id,
    playerId: row.player_id || null,
    createdAt: new Date(row.created_at).toISOString(),
    levelNumber: row.level_number,
    score: row.score,
    kills: row.kills,
    gameResult: row.game_result,
    durationTicks: row.duration_ticks,
    validationStatus: row.validation_status,
    singlePlayerSessionId: row.single_player_session_id || null,
  }));
}

// Admin/worker read: fetch a replay record by id WITHOUT guest scoping. Used
// only by server-side validation (scripts/validate-results.js) — never expose
// through a client-facing endpoint. In Postgres mode only the metadata row is
// returned (replay: null) — the cross-checks don't need the input payload.
async function readRecordAdmin(id) {
  if (!isSafeId(id)) {
    return null;
  }

  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `
      SELECT id, guest_id, player_id, created_at, level_number, score, kills,
          game_result, duration_ticks, validation_status, single_player_session_id
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
      playerId: row.player_id || null,
      createdAt: new Date(row.created_at).toISOString(),
      levelNumber: row.level_number,
      score: row.score,
      kills: row.kills,
      gameResult: row.game_result,
      durationTicks: row.duration_ticks,
      validationStatus: row.validation_status,
      singlePlayerSessionId: row.single_player_session_id || null,
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
      SELECT id, guest_id, player_id, created_at, level_number, score, kills,
        game_result, duration_ticks, replay_json, validation_status,
        single_player_session_id
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
  const replay = row.replay_json;
  if (!isValidReplay(replay)) {
    return null;
  }

  return {
    id: row.id,
    guestId: row.guest_id,
    playerId: row.player_id || null,
    createdAt: new Date(row.created_at).toISOString(),
    levelNumber: row.level_number,
    score: row.score,
    kills: row.kills,
    gameResult: row.game_result,
    durationTicks: row.duration_ticks,
    validationStatus: row.validation_status,
    singlePlayerSessionId: row.single_player_session_id || null,
    replay,
  };
}

async function createPersistentRecord(record, sessionOptions) {
  await ensureSchema();

  return database.withTransaction(async () => {
    const session = await resolvePersistentSession(record, sessionOptions);
    record.singlePlayerSessionId = session.id;

    await getPgPool().query(
    `
      INSERT INTO ${TABLE_NAME}
        (id, guest_id, player_id, created_at, level_number, replay_json,
          score, kills, game_result, duration_ticks,
          validation_status, single_player_session_id)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)
    `,
    [
      record.id,
      record.guestId,
      record.playerId || null,
      record.createdAt,
      record.levelNumber,
      JSON.stringify(record.replay),
      record.score,
      record.kills,
      record.gameResult,
      record.durationTicks,
      record.validationStatus,
      record.singlePlayerSessionId,
    ],
  );

    const completeSession = sessionOptions.completeSession;
    const updated = await getPgPool().query(
      `
        UPDATE battlecity_single_player_sessions
        SET stage_count = stage_count + 1,
          last_stage_number = $2,
          status = CASE WHEN $3 THEN 'completed' ELSE status END,
          completed_at = CASE WHEN $3 THEN NOW() ELSE completed_at END,
          final_score = CASE WHEN $3 THEN $4 ELSE final_score END,
          final_result = CASE WHEN $3 THEN $5 ELSE final_result END
        WHERE id = $1
        RETURNING id, status, started_at, completed_at, stage_count,
          last_stage_number, final_score, final_result
      `,
      [
        session.id,
        record.levelNumber,
        completeSession,
        record.score,
        record.gameResult,
      ],
    );
    record.session = toSessionSummary(updated.rows[0]);

    await prunePersistentRecords(record.guestId);
    return record;
  });
}

async function resolvePersistentSession(record, options) {
  if (options.sessionId !== null) {
    const result = await getPgPool().query(
      `
        SELECT id, status, started_at, completed_at, stage_count,
          last_stage_number, final_score, final_result
        FROM battlecity_single_player_sessions
        WHERE id = $1 AND guest_id = $2
        LIMIT 1
      `,
      [options.sessionId, record.guestId],
    );
    const existing = result.rows[0];
    if (existing === undefined || existing.status !== 'active') {
      throw new Error('Single-player session is unavailable');
    }
    return existing;
  }

  const session = {
    id: createSinglePlayerSessionId(),
    guestId: record.guestId,
    playerId: record.playerId || null,
  };
  const result = await getPgPool().query(
    `
      INSERT INTO battlecity_single_player_sessions (id, guest_id, player_id)
      VALUES ($1, $2, $3)
      RETURNING id, status, started_at, completed_at, stage_count,
        last_stage_number, final_score, final_result
    `,
    [session.id, session.guestId, session.playerId],
  );
  return result.rows[0];
}

async function updatePersistentValidationStatus(id, guestId, validationStatus) {
  await ensureSchema();

  const result = await getPgPool().query(
    `
      UPDATE ${TABLE_NAME}
      SET validation_status = $3
      WHERE id = $1
        AND guest_id = $2
      RETURNING id, guest_id, player_id, created_at, level_number, score, kills,
        game_result, duration_ticks, replay_json, validation_status
    `,
    [id, guestId, validationStatus],
  );

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  const replay = row.replay_json;
  if (!isValidReplay(replay)) {
    return null;
  }

  return {
    id: row.id,
    guestId: row.guest_id,
    playerId: row.player_id || null,
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

async function prunePersistentRecords(guestId) {
  const result = await getPgPool().query(
    `
      SELECT id
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
    playerId: record.playerId || null,
    createdAt: record.createdAt,
    levelNumber: record.levelNumber,
    score: record.score || 0,
    kills: record.kills || 0,
    gameResult: record.gameResult || 'loss',
    durationTicks: record.durationTicks || 0,
    matchStatus: record.validationStatus || 'pending',
    singlePlayerSessionId: record.singlePlayerSessionId || null,
  };
}

function toSessionSummary(session) {
  if (session === null || session === undefined) {
    return null;
  }
  return {
    id: session.id,
    status: session.status,
    startedAt: new Date(session.started_at || session.startedAt).toISOString(),
    completedAt:
      session.completed_at || session.completedAt
        ? new Date(session.completed_at || session.completedAt).toISOString()
        : null,
    stageCount: Number(session.stage_count ?? session.stageCount ?? 0),
    lastStageNumber:
      session.last_stage_number ?? session.lastStageNumber ?? null,
    finalScore: session.final_score ?? session.finalScore ?? null,
    finalResult: session.final_result ?? session.finalResult ?? null,
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

function createSinglePlayerSessionId() {
  return `spr-${Date.now().toString(36)}-${Math.floor(
    Math.random() * 0xffffff,
  ).toString(36)}`;
}

function normalizeSessionOptions(value) {
  const sessionId = isSafeId(value?.sessionId) ? value.sessionId : null;
  return {
    sessionId,
    completeSession: value?.completeSession === true,
  };
}

function createFileSessionSummary(record, completeSession) {
  const startedAt = record.createdAt;
  return {
    id: record.singlePlayerSessionId,
    status: completeSession ? 'completed' : 'active',
    startedAt,
    completedAt: completeSession ? startedAt : null,
    stageCount: 1,
    lastStageNumber: record.levelNumber,
    finalScore: completeSession ? record.score : null,
    finalResult: completeSession ? record.gameResult : null,
  };
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
  toSessionSummary,
};
