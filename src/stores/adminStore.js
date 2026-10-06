const database = require('../database');
const storageConfig = require('../config/storageConfig');

const MATCH_STATUSES = new Set(['pending', 'accepted', 'rejected']);

function assertPersistentStorage() {
  if (!storageConfig.hasDatabaseConfig()) {
    const error = new Error('Admin reporting requires PostgreSQL');
    error.code = 'DATABASE_REQUIRED';
    throw error;
  }
}

async function getOverview() {
  assertPersistentStorage();
  await database.assertMigrationsApplied();
  const result = await database.getPool().query(`
    SELECT
      (SELECT COUNT(*) FROM battlecity_players WHERE provider IN ('guest', 'wallet'))::INTEGER AS players,
      (SELECT COUNT(*) FROM battlecity_match_results WHERE mode = 'single' AND provider IN ('guest', 'wallet'))::INTEGER AS matches,
      (SELECT COUNT(*) FROM battlecity_match_results WHERE mode = 'single' AND provider IN ('guest', 'wallet') AND validation_status = 'pending')::INTEGER AS pending_matches,
      (SELECT COUNT(*) FROM battlecity_match_results WHERE mode = 'single' AND provider IN ('guest', 'wallet') AND validation_status = 'accepted')::INTEGER AS accepted_matches,
      (SELECT COUNT(*) FROM battlecity_match_results WHERE mode = 'single' AND provider IN ('guest', 'wallet') AND validation_status = 'rejected')::INTEGER AS rejected_matches,
      (SELECT COUNT(*) FROM battlecity_ranking_payouts WHERE status IN ('pending', 'prepared', 'failed'))::INTEGER AS pending_payouts
  `);
  return fromOverviewRow(result.rows[0]);
}

async function listMatches(options = {}) {
  assertPersistentStorage();
  await database.assertMigrationsApplied();
  const limit = clampInteger(options.limit, 1, 100, 50);
  const offset = clampInteger(options.offset, 0, 100000, 0);
  const statuses = parseMatchStatuses(options.status);
  const result = await database.getPool().query(`
    SELECT m.*, p.display_name AS player_name, p.wallet_address AS player_wallet,
      (r.id IS NOT NULL) AS replay_available, COUNT(*) OVER()::INTEGER AS total_count
    FROM battlecity_match_results m
    JOIN battlecity_players p ON p.id = m.player_id
    LEFT JOIN battlecity_replays r ON r.id = m.replay_id AND r.player_id = m.player_id
    WHERE p.provider IN ('wallet', 'guest') AND m.mode = 'single'
      AND ($1::TEXT[] IS NULL OR m.validation_status = ANY($1))
    ORDER BY m.created_at DESC, m.id DESC LIMIT $2 OFFSET $3`,
    [statuses, limit, offset]);

  return {
    items: result.rows.map(fromMatchRow),
    total: result.rowCount > 0 ? Number(result.rows[0].total_count) : 0,
    limit,
    offset,
  };
}

async function listReplays(options = {}) {
  assertPersistentStorage();
  await database.assertMigrationsApplied();
  const limit = clampInteger(options.limit, 1, 100, 50);
  const offset = clampInteger(options.offset, 0, 100000, 0);
  const result = await database.getPool().query(
    `
      SELECT
        COALESCE(s.id, r.id) AS id,
        r.guest_id,
        MAX(r.player_id) AS player_id,
        MAX(p.display_name) AS player_display_name,
        MIN(r.created_at) AS started_at,
        MAX(r.created_at) AS saved_at,
        COALESCE(s.status, 'completed') AS status,
        COALESCE(s.final_score, (ARRAY_AGG(r.score ORDER BY r.created_at DESC))[1]) AS final_score,
        COALESCE(s.final_result, (ARRAY_AGG(r.game_result ORDER BY r.created_at DESC))[1]) AS final_result,
        COALESCE(s.completed_at, MAX(r.created_at)) AS completed_at,
        COALESCE(s.stage_count, COUNT(r.id)) AS stage_count,
        COALESCE(SUM(r.duration_ticks), 0) AS duration_ticks,
        JSONB_AGG(
          JSONB_BUILD_OBJECT(
            'id', r.id,
            'levelNumber', r.level_number,
            'score', r.score,
            'kills', r.kills,
            'gameResult', r.game_result,
            'durationTicks', r.duration_ticks,
            'createdAt', r.created_at
          )
          ORDER BY r.level_number ASC, r.created_at ASC
        ) AS stages,
        COUNT(*) OVER()::INTEGER AS total_count
      FROM battlecity_replays r
      LEFT JOIN battlecity_single_player_sessions s
        ON s.id = r.single_player_session_id
      LEFT JOIN battlecity_players p ON p.id = r.player_id
      GROUP BY COALESCE(s.id, r.id), r.guest_id, s.status, s.final_score,
        s.final_result, s.completed_at, s.stage_count
      ORDER BY MAX(r.created_at) DESC
      LIMIT $1 OFFSET $2
    `,
    [limit, offset],
  );
  return {
    items: result.rows.map((row) => ({
      id: row.id,
      guestId: row.guest_id,
      playerId: row.player_id || null,
      playerDisplayName: row.player_display_name || null,
      startedAt: toIso(row.started_at),
      completedAt: toIso(row.completed_at),
      savedAt: toIso(row.saved_at),
      status: row.status,
      score: Number(row.final_score || 0),
      gameResult: row.final_result || 'loss',
      stageCount: Number(row.stage_count || 0),
      durationTicks: Number(row.duration_ticks || 0),
      stages: Array.isArray(row.stages) ? row.stages.map((stage) => ({
        id: stage.id,
        levelNumber: Number(stage.levelNumber),
        score: Number(stage.score),
        kills: Number(stage.kills),
        gameResult: stage.gameResult,
        durationTicks: Number(stage.durationTicks),
        createdAt: toIso(stage.createdAt),
      })) : [],
    })),
    total: result.rowCount > 0 ? Number(result.rows[0].total_count) : 0,
    limit,
    offset,
  };
}

async function getReplay(id) {
  assertPersistentStorage();
  await database.assertMigrationsApplied();
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,120}$/i.test(id)) {
    return null;
  }

  const result = await database.getPool().query(
    `
      SELECT r.id, r.guest_id, r.player_id, r.created_at, r.level_number,
        r.score, r.kills, r.game_result, r.duration_ticks, r.validation_status,
        r.replay_json, p.display_name AS player_display_name
      FROM battlecity_replays r
      LEFT JOIN battlecity_players p ON p.id = r.player_id
      WHERE r.id = $1
      LIMIT 1
    `,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined || row.replay_json === null || typeof row.replay_json !== 'object') {
    return null;
  }

  return {
    id: row.id,
    guestId: row.guest_id,
    playerId: row.player_id || null,
    playerDisplayName: row.player_display_name || null,
    createdAt: toIso(row.created_at),
    levelNumber: Number(row.level_number),
    score: Number(row.score),
    kills: Number(row.kills),
    gameResult: row.game_result,
    durationTicks: Number(row.duration_ticks),
    validationStatus: row.validation_status,
    replay: row.replay_json,
  };
}

function parseMatchStatuses(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const statuses = value.split(',').map((item) => item.trim()).filter((item) => MATCH_STATUSES.has(item));
  return statuses.length ? statuses : null;
}

async function listPlayers(options = {}) {
  assertPersistentStorage();
  await database.assertMigrationsApplied();
  const limit = clampInteger(options.limit, 1, 100, 50);
  const offset = clampInteger(options.offset, 0, 100000, 0);
  const query = typeof options.query === 'string' ? options.query.trim().slice(0, 120) : '';
  const search = query === '' ? null : `%${query}%`;
  const lastSeenFrom = /^\d{4}-\d{2}-\d{2}$/.test(options.lastSeenFrom)
    ? options.lastSeenFrom
    : null;
  const lastSeenTo = /^\d{4}-\d{2}-\d{2}$/.test(options.lastSeenTo)
    ? options.lastSeenTo
    : null;
  const xConnected = options.xConnected === 'true';

  const result = await database.getPool().query(
    `
      SELECT
        p.id, p.provider, p.display_name, p.wallet_address,
        p.highscore_primary, p.highscore_secondary,
        p.created_at, p.last_seen_at,
        COALESCE(e.token_balance, 0) AS token_balance,
        COALESCE(e.sol_balance, 0) AS sol_balance,
        COALESCE(e.fuel_balance, 0) AS fuel_balance,
        x.x_username AS x_username,
        x.follows_battlecities AS x_follows_battlecities,
        COALESCE(stats.matches_played, 0) AS matches_played,
        COALESCE(stats.matches_completed, 0) AS matches_completed,
        COALESCE(stats.best_score, 0) AS best_score,
        COUNT(*) OVER()::INTEGER AS total_count
      FROM battlecity_players p
      LEFT JOIN battlecity_economy_accounts e ON e.player_id = p.id
      LEFT JOIN battlecity_x_connections x ON x.player_id = p.id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::INTEGER AS matches_played,
          COUNT(*) FILTER (WHERE validation_status = 'accepted')::INTEGER AS matches_completed,
          MAX(score) FILTER (WHERE validation_status <> 'rejected') AS best_score
        FROM battlecity_match_results WHERE player_id = p.id AND mode = 'single'
      ) stats ON TRUE
      WHERE p.provider IN ('wallet', 'guest')
        AND ($1::TEXT IS NULL OR p.display_name ILIKE $1 OR p.wallet_address ILIKE $1 OR p.id ILIKE $1)
        AND ($4::DATE IS NULL OR p.last_seen_at >= $4::DATE)
        AND ($5::DATE IS NULL OR p.last_seen_at < ($5::DATE + INTERVAL '1 day'))
        AND ($6::BOOLEAN = FALSE OR x.player_id IS NOT NULL)
      ORDER BY p.last_seen_at DESC
      LIMIT $2 OFFSET $3
    `,
    [search, limit, offset, lastSeenFrom, lastSeenTo, xConnected],
  );

  return {
    items: result.rows.map(fromPlayerRow),
    total: result.rowCount > 0 ? Number(result.rows[0].total_count) : 0,
    limit,
    offset,
  };
}

function fromOverviewRow(row) {
  return {
    players: Number(row.players),
    matches: Number(row.matches),
    pendingMatches: Number(row.pending_matches),
    acceptedMatches: Number(row.accepted_matches),
    rejectedMatches: Number(row.rejected_matches),
    pendingPayouts: Number(row.pending_payouts),
  };
}

function fromMatchRow(row) {
  return {
    id: row.id, playerId: row.player_id, displayName: row.player_name,
    walletAddress: row.player_wallet, provider: row.provider, seasonId: row.season_id,
    mode: row.mode, levelNumber: Number(row.level_number), score: Number(row.score),
    gamePoints: Number(row.game_points), won: Boolean(row.won),
    validationStatus: row.validation_status, replayId: row.replay_available ? row.replay_id : null,
    createdAt: toIso(row.created_at),
  };
}

function fromPlayerRow(row) {
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.display_name,
    walletAddress: row.wallet_address,
    highscorePrimary: Number(row.highscore_primary),
    highscoreSecondary: Number(row.highscore_secondary),
    tokenBalance: Number(row.token_balance),
    solBalance: Number(row.sol_balance),
    fuelBalance: Number(row.fuel_balance),
    xUsername: row.x_username || null,
    xFollowsBattleCities: Boolean(row.x_follows_battlecities),
    matchesPlayed: Number(row.matches_played),
    matchesCompleted: Number(row.matches_completed),
    bestScore: Number(row.best_score),
    createdAt: toIso(row.created_at),
    lastSeenAt: toIso(row.last_seen_at),
  };
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function toIso(value) {
  return value == null ? null : new Date(value).toISOString();
}

module.exports = { getOverview, getReplay, listMatches, listPlayers, listReplays };
