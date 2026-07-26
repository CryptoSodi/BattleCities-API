const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const storageConfig = require('../config/storageConfig');
const database = require('../database');

// Server-owned match results (see the plan's "Matches/Rankings"). The client
// submits raw match facts (score, level reached, win flag); the server clamps
// them and derives Game Points itself — client-sent points are never trusted.
// Results start as validation_status 'pending'; a later validation worker
// (Milestone 7) can re-simulate replays and flip them to accepted/rejected.
// Leaderboards aggregate pending + accepted so the loop works before the
// worker exists, and exclude rejected.

const TABLE_NAME = 'battlecity_match_results';
const MAX_LEADERBOARD_LIMIT = 100;

// Game point derivation, Mattle-Run-style: score contribution, per-level
// clear bonus, win bonus, all under a hard per-match cap.
const MAX_SCORE_INPUT = 1000000;
const MAX_LEVEL_INPUT = 99;
const SCORE_DIVISOR = 10;
const LEVEL_CLEAR_BONUS = 100;
const WIN_BONUS = 500;
const MATCH_POINT_CAP = 2000;

function getDataDir() {
  return (
    process.env.BATTLECITY_MATCH_DIR ||
    path.join(process.cwd(), 'server-data', 'match-results')
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

// Derives Game Points from clamped match facts. Kept as a pure function so a
// future validation worker can recompute and compare.
function computeGamePoints(input) {
  const score = clampInteger(input.score, 0, MAX_SCORE_INPUT);
  const levelNumber = clampInteger(input.levelNumber, 1, MAX_LEVEL_INPUT);
  const won = input.won === true;

  const scorePoints = Math.floor(score / SCORE_DIVISOR);
  const levelPoints = (levelNumber - 1) * LEVEL_CLEAR_BONUS;
  const winPoints = won ? WIN_BONUS : 0;

  return Math.min(MATCH_POINT_CAP, scorePoints + levelPoints + winPoints);
}

async function submitResult(player, season, input) {
  if (!isValidPlayer(player)) {
    throw new Error('Invalid player');
  }
  if (typeof season !== 'object' || season === null || typeof season.id !== 'string') {
    throw new Error('Invalid season');
  }

  const facts = typeof input === 'object' && input !== null ? input : {};
  const result = {
    id: createResultId(),
    playerId: player.id,
    // Guest results are stored (a guest can see their own numbers) but the
    // provider tag keeps them OUT of every leaderboard/rank aggregation —
    // guests are virtual players (see services/playerPolicy.js).
    provider: player.provider,
    walletAddress: player.walletAddress || null,
    displayName:
      typeof player.displayName === 'string' ? player.displayName : 'Player',
    seasonId: season.id,
    mode: facts.mode === 'multi' ? 'multi' : 'single',
    levelNumber: clampInteger(facts.levelNumber, 1, MAX_LEVEL_INPUT),
    score: clampInteger(facts.score, 0, MAX_SCORE_INPUT),
    gamePoints: computeGamePoints(facts),
    won: facts.won === true,
    replayId: typeof facts.replayId === 'string' ? facts.replayId : null,
    validationStatus: 'pending',
    createdAt: new Date().toISOString(),
  };

  if (hasPersistentConfig()) {
    await ensureSchema();
    await getPgPool().query(
      `
        INSERT INTO ${TABLE_NAME}
          (
            id, player_id, provider, wallet_address, display_name, season_id,
            mode, level_number, score, game_points, won, replay_id,
            validation_status, created_at
          )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `,
      [
        result.id,
        result.playerId,
        result.provider,
        result.walletAddress,
        result.displayName,
        result.seasonId,
        result.mode,
        result.levelNumber,
        result.score,
        result.gamePoints,
        result.won,
        result.replayId,
        result.validationStatus,
        result.createdAt,
      ],
    );
    return result;
  }

  await fs.mkdir(getDataDir(), { recursive: true });
  await fs.writeFile(
    path.join(getDataDir(), `${result.id}.json`),
    JSON.stringify(result),
    'utf8',
  );

  return result;
}

// Aggregated Game Points per player, ranked. seasonId null/'' => all-time.
async function getLeaderboard(seasonId, limit = 20) {
  const safeLimit = Math.max(
    1,
    Math.min(MAX_LEADERBOARD_LIMIT, Number(limit) || 20),
  );
  const scopeSeasonId =
    typeof seasonId === 'string' && seasonId !== '' ? seasonId : null;

  if (hasPersistentConfig()) {
    await ensureSchema();
    const params = [];
    // Guests are virtual players — never ranked (services/playerPolicy.js).
    let where = `validation_status <> 'rejected' AND provider <> 'guest'`;
    if (scopeSeasonId !== null) {
      params.push(scopeSeasonId);
      where += ` AND season_id = $${params.length}`;
    }
    params.push(safeLimit);

    const result = await getPgPool().query(
      `
        SELECT player_id,
          MAX(wallet_address) AS wallet_address,
          MAX(display_name) AS display_name,
          SUM(game_points)::bigint AS total_points,
          COUNT(*)::int AS matches
        FROM ${TABLE_NAME}
        WHERE ${where}
        GROUP BY player_id
        ORDER BY total_points DESC, player_id ASC
        LIMIT $${params.length}
      `,
      params,
    );

    return result.rows.map((row, index) => ({
      rank: index + 1,
      playerId: row.player_id,
      walletAddress: row.wallet_address,
      displayName: row.display_name,
      totalPoints: Number(row.total_points),
      matches: Number(row.matches),
    }));
  }

  const totals = await aggregateFileResults(scopeSeasonId);
  return totals
    .sort(
      (a, b) =>
        b.totalPoints - a.totalPoints ||
        (a.playerId < b.playerId ? -1 : 1),
    )
    .slice(0, safeLimit)
    .map((row, index) => ({ rank: index + 1, ...row }));
}

// Rank + totals of a single player in a scope; null when they have no
// results there. Rank counts players with strictly more points, mirroring
// the leaderboard's ordering.
async function getPlayerRank(playerId, seasonId) {
  if (!isValidPlayerId(playerId)) {
    return null;
  }

  const scopeSeasonId =
    typeof seasonId === 'string' && seasonId !== '' ? seasonId : null;

  let totals;
  if (hasPersistentConfig()) {
    await ensureSchema();
    const params = [];
    // Guests are virtual players — never ranked (services/playerPolicy.js).
    let where = `validation_status <> 'rejected' AND provider <> 'guest'`;
    if (scopeSeasonId !== null) {
      params.push(scopeSeasonId);
      where += ` AND season_id = $${params.length}`;
    }

    const result = await getPgPool().query(
      `
        SELECT player_id,
          SUM(game_points)::bigint AS total_points,
          COUNT(*)::int AS matches
        FROM ${TABLE_NAME}
        WHERE ${where}
        GROUP BY player_id
      `,
      params,
    );
    totals = result.rows.map((row) => ({
      playerId: row.player_id,
      totalPoints: Number(row.total_points),
      matches: Number(row.matches),
    }));
  } else {
    totals = await aggregateFileResults(scopeSeasonId);
  }

  const me = totals.find((row) => row.playerId === playerId);
  if (me === undefined) {
    return null;
  }

  const better = totals.filter(
    (row) => row.totalPoints > me.totalPoints,
  ).length;

  return {
    rank: better + 1,
    totalPoints: me.totalPoints,
    matches: me.matches,
  };
}

async function aggregateFileResults(scopeSeasonId) {
  let files;
  try {
    files = await fs.readdir(getDataDir());
  } catch {
    return [];
  }

  const byPlayer = new Map();
  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue;
    }

    let result;
    try {
      result = JSON.parse(
        await fs.readFile(path.join(getDataDir(), file), 'utf8'),
      );
    } catch {
      continue;
    }

    if (typeof result !== 'object' || result === null) {
      continue;
    }
    if (result.validationStatus === 'rejected') {
      continue;
    }
    // Guests are virtual players — never ranked (services/playerPolicy.js).
    if (result.provider === 'guest') {
      continue;
    }
    if (scopeSeasonId !== null && result.seasonId !== scopeSeasonId) {
      continue;
    }

    const existing = byPlayer.get(result.playerId) || {
      playerId: result.playerId,
      walletAddress: result.walletAddress || null,
      displayName: result.displayName || 'Player',
      totalPoints: 0,
      matches: 0,
    };
    existing.totalPoints += Number(result.gamePoints) || 0;
    existing.matches += 1;
    byPlayer.set(result.playerId, existing);
  }

  return Array.from(byPlayer.values());
}

function toPublicResult(result) {
  return {
    id: result.id,
    seasonId: result.seasonId,
    mode: result.mode,
    levelNumber: result.levelNumber,
    score: result.score,
    gamePoints: result.gamePoints,
    won: result.won,
    validationStatus: result.validationStatus,
    createdAt: result.createdAt,
  };
}

function clampInteger(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function createResultId() {
  return `mtc-${Date.now().toString(36)}-${crypto
    .randomBytes(8)
    .toString('hex')}`;
}

function isValidPlayerId(value) {
  return typeof value === 'string' && /^ply-[a-z0-9-]+$/i.test(value);
}

function isValidPlayer(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    isValidPlayerId(value.id) &&
    (value.provider === 'guest' ||
      value.provider === 'wallet' ||
      value.provider === 'google')
  );
}

module.exports = {
  computeGamePoints,
  getLeaderboard,
  getPlayerRank,
  submitResult,
  toPublicResult,
  isPersistentStoreConfigured: hasPersistentConfig,
};
