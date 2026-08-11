const database = require('../database');
const storageConfig = require('../config/storageConfig');

const MATCH_STATUSES = new Set([
  'waiting',
  'ready',
  'live',
  'transition',
  'completed',
  'closed',
]);
const MATCH_CATEGORIES = new Set(['direct', 'event']);

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
      (SELECT COUNT(*) FROM battlecity_players)::INTEGER AS players,
      (SELECT COUNT(*) FROM battlecity_multiplayer_matches)::INTEGER AS matches,
      (SELECT COUNT(*) FROM battlecity_multiplayer_matches
        WHERE status IN ('waiting', 'ready', 'live', 'transition'))::INTEGER
        AS active_matches,
      (SELECT COUNT(*) FROM battlecity_multiplayer_matches
        WHERE status = 'completed')::INTEGER AS completed_matches,
      (SELECT COUNT(*) FROM battlecity_tournaments
        WHERE status NOT IN ('cancelled', 'ended'))::INTEGER AS active_tournaments,
      (SELECT COUNT(*) FROM battlecity_tournaments
        WHERE status <> 'cancelled' AND ends_at <= NOW()
          AND prizes_distributed_at IS NULL)::INTEGER AS pending_payouts
  `);
  return fromOverviewRow(result.rows[0]);
}

async function listMatches(options = {}) {
  assertPersistentStorage();
  await database.assertMigrationsApplied();
  const limit = clampInteger(options.limit, 1, 100, 50);
  const offset = clampInteger(options.offset, 0, 100000, 0);
  const statuses = parseMatchStatuses(options.status);
  const category = MATCH_CATEGORIES.has(options.category) ? options.category : null;

  const result = await database.getPool().query(
    `
      SELECT
        m.id, m.category, m.event_id, m.status, m.current_stage,
        m.open_slots, m.broadcaster_status, m.broadcaster_started_at,
        m.headless_target,
        m.created_at, m.updated_at, m.started_at, m.completed_at, m.closed_at,
        COUNT(*) OVER()::INTEGER AS total_count,
        COALESCE(
          JSONB_AGG(
            JSONB_BUILD_OBJECT(
              'playerId', p.player_id,
              'playerSlot', p.player_slot,
              'displayName', pl.display_name,
              'provider', pl.provider,
              'active', p.active,
              'score', s.score,
              'validationStatus', s.validation_status
            ) ORDER BY p.player_slot, p.joined_at
          ) FILTER (WHERE p.player_id IS NOT NULL),
          '[]'::JSONB
        ) AS players
      FROM battlecity_multiplayer_matches m
      LEFT JOIN battlecity_multiplayer_participants p ON p.match_id = m.id
      LEFT JOIN battlecity_players pl ON pl.id = p.player_id
      LEFT JOIN battlecity_multiplayer_scores s
        ON s.match_id = p.match_id AND s.player_id = p.player_id
      WHERE ($1::TEXT[] IS NULL OR m.status = ANY($1))
        AND ($2::TEXT IS NULL OR m.category = $2)
      GROUP BY m.id
      ORDER BY m.created_at DESC
      LIMIT $3 OFFSET $4
    `,
    [statuses, category, limit, offset],
  );

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
      SELECT r.id, r.guest_id, r.player_id, r.created_at, r.level_number,
        r.score, r.kills, r.game_result, r.duration_ticks, r.validation_status,
        p.display_name AS player_display_name,
        COUNT(*) OVER()::INTEGER AS total_count
      FROM battlecity_replays r
      LEFT JOIN battlecity_players p ON p.id = r.player_id
      ORDER BY r.created_at DESC
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
      createdAt: toIso(row.created_at),
      levelNumber: Number(row.level_number),
      score: Number(row.score),
      kills: Number(row.kills),
      gameResult: row.game_result,
      durationTicks: Number(row.duration_ticks),
      validationStatus: row.validation_status,
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
  const expanded = [];
  for (const token of value.split(',').map((item) => item.trim())) {
    if (token === 'active') {
      expanded.push('waiting', 'ready', 'live', 'transition');
    } else if (MATCH_STATUSES.has(token)) {
      expanded.push(token);
    }
  }
  return expanded.length === 0 ? null : expanded;
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

  const result = await database.getPool().query(
    `
      SELECT
        p.id, p.provider, p.display_name, p.google_email,
        p.highscore_primary, p.highscore_secondary,
        p.created_at, p.last_seen_at,
        COALESCE(e.token_balance, 0) AS token_balance,
        COALESCE(e.sol_balance, 0) AS sol_balance,
        COALESCE(e.fuel_balance, 0) AS fuel_balance,
        COUNT(DISTINCT mp.match_id)::INTEGER AS matches_played,
        COUNT(DISTINCT mp.match_id) FILTER (WHERE mm.status = 'completed')::INTEGER
          AS matches_completed,
        COALESCE(MAX(ms.score), 0)::BIGINT AS best_multiplayer_score,
        COUNT(*) OVER()::INTEGER AS total_count
      FROM battlecity_players p
      LEFT JOIN battlecity_economy_accounts e ON e.player_id = p.id
      LEFT JOIN battlecity_multiplayer_participants mp ON mp.player_id = p.id
      LEFT JOIN battlecity_multiplayer_matches mm ON mm.id = mp.match_id
      LEFT JOIN battlecity_multiplayer_scores ms
        ON ms.match_id = mp.match_id AND ms.player_id = p.id
          AND ms.validation_status = 'accepted'
      WHERE ($1::TEXT IS NULL OR p.display_name ILIKE $1 OR p.google_email ILIKE $1
        OR p.id ILIKE $1)
        AND ($4::DATE IS NULL OR p.last_seen_at >= $4::DATE)
        AND ($5::DATE IS NULL OR p.last_seen_at < ($5::DATE + INTERVAL '1 day'))
      GROUP BY p.id, e.player_id
      ORDER BY p.last_seen_at DESC
      LIMIT $2 OFFSET $3
    `,
    [search, limit, offset, lastSeenFrom, lastSeenTo],
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
    activeMatches: Number(row.active_matches),
    completedMatches: Number(row.completed_matches),
    activeTournaments: Number(row.active_tournaments),
    pendingPayouts: Number(row.pending_payouts),
  };
}

function fromMatchRow(row) {
  return {
    id: row.id,
    category: row.category,
    eventId: row.event_id,
    status: row.status,
    currentStage: Number(row.current_stage),
    openSlots: Array.isArray(row.open_slots) ? row.open_slots.map(Number) : [],
    broadcasterStatus: row.broadcaster_status,
    broadcasterStartedAt: toIso(row.broadcaster_started_at),
    headlessTarget: ['worker', 'bom1'].includes(row.headless_target)
      ? row.headless_target
      : null,
    players: Array.isArray(row.players) ? row.players : [],
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    closedAt: toIso(row.closed_at),
  };
}

function fromPlayerRow(row) {
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.display_name,
    email: row.google_email,
    highscorePrimary: Number(row.highscore_primary),
    highscoreSecondary: Number(row.highscore_secondary),
    tokenBalance: Number(row.token_balance),
    solBalance: Number(row.sol_balance),
    fuelBalance: Number(row.fuel_balance),
    matchesPlayed: Number(row.matches_played),
    matchesCompleted: Number(row.matches_completed),
    bestMultiplayerScore: Number(row.best_multiplayer_score),
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
