const fs = require('fs').promises;
const path = require('path');
const database = require('../database');
const storageConfig = require('../config/storageConfig');

const ARCHIVE_TABLE = 'battlecity_match_archives';
const BATCH_TABLE = 'battlecity_match_archive_batches';
const MAX_BATCH_FRAMES = 40;
const MAX_BATCH_BYTES = 1024 * 1024;
const MAX_LIST_LIMIT = 100;
const MAX_FRAME_BATCH_LIMIT = 100;

let localQueue = Promise.resolve();

function hasPersistentConfig() {
  return storageConfig.hasDatabaseConfig();
}

function getPgPool() {
  return database.getPool();
}

async function ensureSchema() {
  await database.assertMigrationsApplied();
}

function getArchiveDirectory() {
  return (
    process.env.BATTLECITY_MATCH_ARCHIVE_DIR ||
    path.join(process.cwd(), 'server-data', 'match-archives')
  );
}

function getStatePath() {
  return path.join(getArchiveDirectory(), 'state.json');
}

function getFramesPath(matchId) {
  return path.join(getArchiveDirectory(), 'frames', `${matchId}.jsonl`);
}

async function startArchive(matchId, input) {
  const archive = normalizeArchiveStart(matchId, input);
  if (hasPersistentConfig()) {
    await ensureSchema();
    await getPgPool().query(
      `
        INSERT INTO ${ARCHIVE_TABLE}
          (match_id, archive_version, status, game_type, category,
           level_number, seed, simulation_config_json, players_json,
           started_at, created_at, updated_at)
        VALUES ($1, 1, 'recording', $2, $3, $4, $5, $6::jsonb, $7::jsonb,
                $8, $9, $9)
        ON CONFLICT (match_id) DO UPDATE SET
          game_type = EXCLUDED.game_type,
          category = EXCLUDED.category,
          level_number = EXCLUDED.level_number,
          seed = EXCLUDED.seed,
          simulation_config_json = EXCLUDED.simulation_config_json,
          players_json = EXCLUDED.players_json,
          updated_at = EXCLUDED.updated_at
        WHERE ${ARCHIVE_TABLE}.status <> 'completed'
      `,
      [
        archive.matchId,
        archive.gameType,
        archive.category,
        archive.level,
        archive.seed,
        JSON.stringify(archive.simulationConfig),
        JSON.stringify(archive.players),
        archive.startedAt,
        new Date().toISOString(),
      ],
    );
    return getArchive(matchId);
  }

  return withLocalLock(async () => {
    const state = await readLocalState();
    const existing = state.archives.find((item) => item.matchId === matchId);
    if (existing === undefined) {
      state.archives.push({
        ...archive,
        archiveVersion: 1,
        status: 'recording',
        result: null,
        frameCount: 0,
        firstFrameSeq: null,
        lastFrameSeq: null,
        finalTick: null,
        completedAt: null,
        batches: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } else if (existing.status !== 'completed') {
      Object.assign(existing, archive, { updatedAt: new Date().toISOString() });
    }
    await writeLocalState(state);
    return toPublicLocalArchive(
      state.archives.find((item) => item.matchId === matchId),
    );
  });
}

async function appendFrames(matchId, rawFrames) {
  const frames = normalizeFrameBatch(rawFrames);
  const startSeq = frames[0].seq;
  const endSeq = frames[frames.length - 1].seq;

  if (hasPersistentConfig()) {
    await ensureSchema();
    return database.withTransaction(async () => {
      const archiveResult = await getPgPool().query(
        `SELECT status, last_frame_seq FROM ${ARCHIVE_TABLE}
         WHERE match_id = $1 FOR UPDATE`,
        [matchId],
      );
      if (archiveResult.rowCount === 0) {
        throw createStoreError('ARCHIVE_NOT_FOUND', 'Match archive not found');
      }
      if (archiveResult.rows[0].status === 'completed') {
        throw createStoreError('ARCHIVE_COMPLETED', 'Match archive is complete');
      }

      const existing = await getPgPool().query(
        `SELECT end_seq, frame_count FROM ${BATCH_TABLE}
         WHERE match_id = $1 AND start_seq = $2`,
        [matchId, startSeq],
      );
      if (existing.rowCount > 0) {
        if (
          Number(existing.rows[0].end_seq) !== endSeq ||
          Number(existing.rows[0].frame_count) !== frames.length
        ) {
          throw createStoreError(
            'ARCHIVE_SEQUENCE_CONFLICT',
            'Archive batch conflicts with stored frames',
          );
        }
        return getArchive(matchId);
      }

      const lastSeq = archiveResult.rows[0].last_frame_seq;
      const expectedSeq = lastSeq === null ? 1 : Number(lastSeq) + 1;
      if (startSeq !== expectedSeq) {
        throw createStoreError(
          'ARCHIVE_SEQUENCE_CONFLICT',
          `Expected frame ${expectedSeq}, received ${startSeq}`,
        );
      }

      await getPgPool().query(
        `INSERT INTO ${BATCH_TABLE}
           (match_id, start_seq, end_seq, frame_count, frames_json)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [matchId, startSeq, endSeq, frames.length, JSON.stringify(frames)],
      );
      await getPgPool().query(
        `UPDATE ${ARCHIVE_TABLE}
         SET frame_count = frame_count + $2,
             first_frame_seq = COALESCE(first_frame_seq, $3),
             last_frame_seq = $4,
             final_tick = $5,
             updated_at = $6
         WHERE match_id = $1`,
        [
          matchId,
          frames.length,
          startSeq,
          endSeq,
          frames[frames.length - 1].tick,
          new Date().toISOString(),
        ],
      );
      return getArchive(matchId);
    });
  }

  return withLocalLock(async () => {
    const state = await readLocalState();
    const archive = state.archives.find((item) => item.matchId === matchId);
    if (archive === undefined) {
      throw createStoreError('ARCHIVE_NOT_FOUND', 'Match archive not found');
    }
    if (archive.status === 'completed') {
      throw createStoreError('ARCHIVE_COMPLETED', 'Match archive is complete');
    }
    const existing = archive.batches.find((batch) => batch.startSeq === startSeq);
    if (existing !== undefined) {
      if (existing.endSeq !== endSeq || existing.frameCount !== frames.length) {
        throw createStoreError(
          'ARCHIVE_SEQUENCE_CONFLICT',
          'Archive batch conflicts with stored frames',
        );
      }
      return toPublicLocalArchive(archive);
    }
    const expectedSeq =
      archive.lastFrameSeq === null ? 1 : archive.lastFrameSeq + 1;
    if (startSeq !== expectedSeq) {
      throw createStoreError(
        'ARCHIVE_SEQUENCE_CONFLICT',
        `Expected frame ${expectedSeq}, received ${startSeq}`,
      );
    }

    await fs.mkdir(path.dirname(getFramesPath(matchId)), { recursive: true });
    await fs.appendFile(
      getFramesPath(matchId),
      `${JSON.stringify(frames)}\n`,
      'utf8',
    );
    archive.batches.push({
      startSeq,
      endSeq,
      frameCount: frames.length,
    });
    archive.frameCount += frames.length;
    archive.firstFrameSeq = archive.firstFrameSeq ?? startSeq;
    archive.lastFrameSeq = endSeq;
    archive.finalTick = frames[frames.length - 1].tick;
    archive.updatedAt = new Date().toISOString();
    await writeLocalState(state);
    return toPublicLocalArchive(archive);
  });
}

async function completeArchive(matchId, input) {
  const result = normalizeJsonObject(input?.result, {});
  const completedAt = normalizeDate(input?.completedAt, new Date().toISOString());
  if (hasPersistentConfig()) {
    await ensureSchema();
    const saved = await getPgPool().query(
      `UPDATE ${ARCHIVE_TABLE}
       SET status = 'completed',
           result_json = $2::jsonb,
           completed_at = COALESCE(completed_at, $3),
           updated_at = $3
       WHERE match_id = $1
       RETURNING match_id`,
      [matchId, JSON.stringify(result), completedAt],
    );
    if (saved.rowCount === 0) {
      throw createStoreError('ARCHIVE_NOT_FOUND', 'Match archive not found');
    }
    return getArchive(matchId);
  }

  return withLocalLock(async () => {
    const state = await readLocalState();
    const archive = state.archives.find((item) => item.matchId === matchId);
    if (archive === undefined) {
      throw createStoreError('ARCHIVE_NOT_FOUND', 'Match archive not found');
    }
    archive.status = 'completed';
    archive.result = result;
    archive.completedAt = archive.completedAt || completedAt;
    archive.updatedAt = completedAt;
    await writeLocalState(state);
    return toPublicLocalArchive(archive);
  });
}

async function listArchives(options = {}) {
  const limit = clampInteger(options.limit, 1, MAX_LIST_LIMIT, 50);
  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `SELECT * FROM ${ARCHIVE_TABLE}
       WHERE status = 'completed'
       ORDER BY completed_at DESC NULLS LAST, started_at DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map(toPublicDatabaseArchive);
  }
  const state = await readLocalState();
  return state.archives
    .filter((archive) => archive.status === 'completed')
    .sort((left, right) =>
      String(right.completedAt || right.startedAt).localeCompare(
        String(left.completedAt || left.startedAt),
      ),
    )
    .slice(0, limit)
    .map(toPublicLocalArchive);
}

async function getArchive(matchId) {
  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `SELECT * FROM ${ARCHIVE_TABLE} WHERE match_id = $1`,
      [matchId],
    );
    return result.rowCount === 0
      ? null
      : toPublicDatabaseArchive(result.rows[0]);
  }
  const state = await readLocalState();
  const archive = state.archives.find((item) => item.matchId === matchId);
  return archive === undefined ? null : toPublicLocalArchive(archive);
}

async function getArchiveFrames(matchId, options = {}) {
  const afterSeq = clampInteger(options.afterSeq, 0, Number.MAX_SAFE_INTEGER, 0);
  const batchLimit = clampInteger(
    options.batchLimit,
    1,
    MAX_FRAME_BATCH_LIMIT,
    20,
  );
  if (hasPersistentConfig()) {
    await ensureSchema();
    const archive = await getArchive(matchId);
    if (archive === null) {
      return null;
    }
    const result = await getPgPool().query(
      `SELECT start_seq, end_seq, frames_json
       FROM ${BATCH_TABLE}
       WHERE match_id = $1 AND end_seq > $2
       ORDER BY start_seq ASC
       LIMIT $3`,
      [matchId, afterSeq, batchLimit + 1],
    );
    const selected = result.rows.slice(0, batchLimit);
    const frames = selected
      .flatMap((row) => row.frames_json)
      .filter((frame) => Number(frame.seq) > afterSeq);
    return {
      matchId,
      frames,
      hasMore: result.rows.length > batchLimit,
      nextAfterSeq:
        frames.length === 0 ? afterSeq : Number(frames[frames.length - 1].seq),
    };
  }

  const state = await readLocalState();
  const archive = state.archives.find((item) => item.matchId === matchId);
  if (archive === undefined) {
    return null;
  }
  const batches = await readLocalFrameBatches(matchId);
  const selected = batches
    .filter((batch) => Number(batch[batch.length - 1]?.seq) > afterSeq)
    .slice(0, batchLimit + 1);
  const frames = selected
    .slice(0, batchLimit)
    .flat()
    .filter((frame) => Number(frame.seq) > afterSeq);
  return {
    matchId,
    frames,
    hasMore: selected.length > batchLimit,
    nextAfterSeq:
      frames.length === 0 ? afterSeq : Number(frames[frames.length - 1].seq),
  };
}

function normalizeArchiveStart(matchId, input) {
  const category = ['guest', 'live', 'event'].includes(input?.category)
    ? input.category
    : 'live';
  const level = clampInteger(input?.level, 1, 35, 1);
  const seed = clampInteger(input?.seed, 0, 0xffffffff, 0);
  const gameType =
    typeof input?.gameType === 'string' && input.gameType.trim() !== ''
      ? input.gameType.trim().slice(0, 32)
      : category;
  return {
    matchId,
    gameType,
    category,
    level,
    seed,
    simulationConfig: normalizeJsonObject(input?.simulationConfig, {}),
    players: normalizePlayers(input?.players),
    startedAt: normalizeDate(input?.startedAt, new Date().toISOString()),
  };
}

function normalizePlayers(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((player) => player !== null && typeof player === 'object')
    .map((player) => ({
      playerId: String(player.playerId || '').slice(0, 128),
      displayName: String(player.displayName || 'Player').slice(0, 80),
      slot: clampInteger(player.slot, 0, 1, 0),
    }))
    .filter(
      (player, index, players) =>
        player.playerId !== '' &&
        players.findIndex((candidate) => candidate.slot === player.slot) === index,
    )
    .sort((left, right) => left.slot - right.slot)
    .slice(0, 2);
}

function normalizeFrameBatch(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BATCH_FRAMES) {
    throw createStoreError(
      'INVALID_ARCHIVE',
      `Frame batches must contain 1-${MAX_BATCH_FRAMES} frames`,
    );
  }
  const frames = value.map((frame, index) => {
    if (
      frame === null ||
      typeof frame !== 'object' ||
      frame.type !== 'webrtc-host-frame' ||
      !Number.isInteger(frame.seq) ||
      frame.seq <= 0 ||
      !Number.isInteger(frame.tick) ||
      frame.tick < 0
    ) {
      throw createStoreError('INVALID_ARCHIVE', `Invalid frame at index ${index}`);
    }
    if (index > 0 && frame.seq !== value[index - 1].seq + 1) {
      throw createStoreError(
        'INVALID_ARCHIVE',
        'Frame batch sequences must be contiguous',
      );
    }
    return frame;
  });
  if (Buffer.byteLength(JSON.stringify(frames), 'utf8') > MAX_BATCH_BYTES) {
    throw createStoreError('INVALID_ARCHIVE', 'Frame batch is too large');
  }
  return frames;
}

function normalizeJsonObject(value, fallback) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? JSON.parse(JSON.stringify(value))
    : fallback;
}

function normalizeDate(value, fallback) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function toPublicDatabaseArchive(row) {
  return {
    matchId: row.match_id,
    archiveVersion: Number(row.archive_version),
    status: row.status,
    gameType: row.game_type,
    category: row.category,
    level: Number(row.level_number),
    seed: Number(row.seed),
    simulationConfig: row.simulation_config_json,
    players: row.players_json,
    result: row.result_json,
    frameCount: Number(row.frame_count),
    firstFrameSeq:
      row.first_frame_seq === null ? null : Number(row.first_frame_seq),
    lastFrameSeq:
      row.last_frame_seq === null ? null : Number(row.last_frame_seq),
    finalTick: row.final_tick === null ? null : Number(row.final_tick),
    startedAt: new Date(row.started_at).toISOString(),
    completedAt: row.completed_at
      ? new Date(row.completed_at).toISOString()
      : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function toPublicLocalArchive(archive) {
  const { batches, ...publicArchive } = archive;
  return JSON.parse(JSON.stringify(publicArchive));
}

async function readLocalState() {
  try {
    const value = JSON.parse(await fs.readFile(getStatePath(), 'utf8'));
    return {
      archives: Array.isArray(value.archives) ? value.archives : [],
    };
  } catch {
    return { archives: [] };
  }
}

async function writeLocalState(state) {
  await fs.mkdir(getArchiveDirectory(), { recursive: true });
  await fs.writeFile(getStatePath(), JSON.stringify(state), 'utf8');
}

async function readLocalFrameBatches(matchId) {
  try {
    const contents = await fs.readFile(getFramesPath(matchId), 'utf8');
    return contents
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function withLocalLock(operation) {
  const pending = localQueue.then(operation, operation);
  localQueue = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, Math.floor(parsed)))
    : fallback;
}

function createStoreError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  appendFrames,
  completeArchive,
  getArchive,
  getArchiveFrames,
  listArchives,
  startArchive,
};
