const crypto = require('crypto');
const database = require('../database');
const storageConfig = require('../config/storageConfig');
const ledgerStore = require('./ledgerStore');

const STATUSES = new Set(['draft', 'scheduled', 'live', 'ended', 'cancelled']);
const EDITABLE_STATUSES = new Set(['draft', 'scheduled', 'live']);
const CURRENCIES = new Set(['token', 'fuel']);

function assertPersistentStorage() {
  if (!storageConfig.hasDatabaseConfig()) {
    throw createStoreError('DATABASE_REQUIRED', 'Tournament management requires PostgreSQL');
  }
}

async function listTournaments(options = {}) {
  assertPersistentStorage();
  await database.assertMigrationsApplied();
  const publicOnly = options.publicOnly === true;
  const result = await database.getPool().query(
    `
      SELECT t.*,
        (SELECT COUNT(DISTINCT s.player_id)
          FROM battlecity_multiplayer_scores s
          WHERE s.event_id = t.id AND s.validation_status = 'accepted')::INTEGER
          AS participant_count,
        (SELECT COUNT(*) FROM battlecity_multiplayer_matches m
          WHERE m.event_id = t.id)::INTEGER AS match_count,
        (SELECT COUNT(*) FROM battlecity_tournament_prize_distributions d
          WHERE d.tournament_id = t.id)::INTEGER AS distribution_count
      FROM battlecity_tournaments t
      WHERE ($1::BOOLEAN = FALSE OR t.status NOT IN ('draft', 'cancelled'))
      ORDER BY t.starts_at DESC, t.created_at DESC
    `,
    [publicOnly],
  );
  return result.rows.map(fromRow);
}

async function getTournament(value, options = {}) {
  assertPersistentStorage();
  await database.assertMigrationsApplied();
  const result = await database.getPool().query(
    `
      SELECT t.*,
        (SELECT COUNT(DISTINCT s.player_id)
          FROM battlecity_multiplayer_scores s
          WHERE s.event_id = t.id AND s.validation_status = 'accepted')::INTEGER
          AS participant_count,
        (SELECT COUNT(*) FROM battlecity_multiplayer_matches m
          WHERE m.event_id = t.id)::INTEGER AS match_count,
        (SELECT COUNT(*) FROM battlecity_tournament_prize_distributions d
          WHERE d.tournament_id = t.id)::INTEGER AS distribution_count
      FROM battlecity_tournaments t
      WHERE (t.id = $1 OR t.slug = $1)
        AND ($2::BOOLEAN = FALSE OR t.status NOT IN ('draft', 'cancelled'))
      LIMIT 1
    `,
    [value, options.publicOnly === true],
  );
  return result.rowCount === 0 ? null : fromRow(result.rows[0]);
}

async function findPublicEvent(value) {
  if (!storageConfig.hasDatabaseConfig()) return null;
  const tournament = await getTournament(value, { publicOnly: true });
  return tournament === null ? null : toEvent(tournament);
}

async function listPublicEvents() {
  if (!storageConfig.hasDatabaseConfig()) return [];
  const tournaments = await listTournaments({ publicOnly: true });
  return tournaments.map(toEvent);
}

async function createTournament(adminPlayerId, input) {
  assertPersistentStorage();
  await database.assertMigrationsApplied();
  const value = normalizeInput(input, null);
  const now = new Date().toISOString();
  const id = `tournament-${crypto.randomBytes(12).toString('hex')}`;
  try {
    const result = await database.getPool().query(
      `
        INSERT INTO battlecity_tournaments
          (id, slug, name, description, status, starts_at, ends_at,
           entry_fuel_cost, level_number, prize_currency, prize_pool,
           created_by_player_id, updated_by_player_id, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $13, $13)
        RETURNING *
      `,
      [
        id, value.slug, value.name, value.description, value.status,
        value.startsAt, value.endsAt, value.entryFuelCost, value.levelNumber,
        value.prizeCurrency, value.prizePool, adminPlayerId, now,
      ],
    );
    return fromRow(result.rows[0]);
  } catch (error) {
    if (error?.code === '23505') {
      throw createStoreError('DUPLICATE_SLUG', 'A tournament with this slug already exists');
    }
    throw error;
  }
}

async function updateTournament(adminPlayerId, tournamentId, input) {
  assertPersistentStorage();
  await database.assertMigrationsApplied();
  return database.withTransaction(async () => {
    const currentResult = await database.getPool().query(
      'SELECT * FROM battlecity_tournaments WHERE id = $1 FOR UPDATE',
      [tournamentId],
    );
    if (currentResult.rowCount === 0) return null;
    const current = fromRow(currentResult.rows[0]);
    if (current.prizesDistributedAt !== null && changesPrizeConfiguration(input, current)) {
      throw createStoreError('PAYOUT_LOCKED', 'Prize settings cannot change after distribution');
    }
    const value = normalizeInput(input, current);
    const now = new Date().toISOString();
    try {
      const result = await database.getPool().query(
        `
          UPDATE battlecity_tournaments SET
            slug = $2, name = $3, description = $4, status = $5,
            starts_at = $6, ends_at = $7, entry_fuel_cost = $8,
            level_number = $9, prize_currency = $10, prize_pool = $11,
            updated_by_player_id = $12, updated_at = $13
          WHERE id = $1
          RETURNING *
        `,
        [
          tournamentId, value.slug, value.name, value.description, value.status,
          value.startsAt, value.endsAt, value.entryFuelCost, value.levelNumber,
          value.prizeCurrency, value.prizePool, adminPlayerId, now,
        ],
      );
      return fromRow(result.rows[0]);
    } catch (error) {
      if (error?.code === '23505') {
        throw createStoreError('DUPLICATE_SLUG', 'A tournament with this slug already exists');
      }
      throw error;
    }
  });
}

async function getLeaderboard(tournamentId, limit = 100) {
  assertPersistentStorage();
  await database.assertMigrationsApplied();
  const safeLimit = clampInteger(limit, 1, 250, 100);
  const result = await database.getPool().query(
    `
      WITH best AS (
        SELECT s.player_id, MAX(s.score)::BIGINT AS score,
          COUNT(DISTINCT s.match_id)::INTEGER AS matches_played
        FROM battlecity_multiplayer_scores s
        WHERE s.event_id = $1 AND s.validation_status = 'accepted'
        GROUP BY s.player_id
      )
      SELECT b.player_id, p.display_name, p.provider, b.score, b.matches_played,
        DENSE_RANK() OVER (ORDER BY b.score DESC)::INTEGER AS rank
      FROM best b
      JOIN battlecity_players p ON p.id = b.player_id
      ORDER BY rank, p.display_name, b.player_id
      LIMIT $2
    `,
    [tournamentId, safeLimit],
  );
  return result.rows.map((row) => ({
    playerId: row.player_id,
    displayName: row.display_name,
    provider: row.provider,
    score: Number(row.score),
    matchesPlayed: Number(row.matches_played),
    rank: Number(row.rank),
  }));
}

async function distributePrizes(adminPlayerId, tournamentId, allocations) {
  assertPersistentStorage();
  await database.assertMigrationsApplied();
  return database.withTransaction(async () => {
    const tournamentResult = await database.getPool().query(
      'SELECT * FROM battlecity_tournaments WHERE id = $1 FOR UPDATE',
      [tournamentId],
    );
    if (tournamentResult.rowCount === 0) return null;
    const tournament = fromRow(tournamentResult.rows[0]);

    const existing = await listDistributions(tournamentId);
    if (existing.length > 0 || tournament.prizesDistributedAt !== null) {
      return { tournament, distributions: existing, alreadyDistributed: true };
    }
    if (effectiveStatus(tournament) !== 'ended') {
      throw createStoreError('TOURNAMENT_NOT_ENDED', 'Tournament has not ended');
    }

    const normalized = normalizeAllocations(allocations);
    const total = normalized.reduce((sum, item) => sum + item.amount, 0);
    if (total > tournament.prizePool) {
      throw createStoreError('PRIZE_POOL_EXCEEDED', 'Allocations exceed the tournament prize pool');
    }

    const eligibleResult = await database.getPool().query(
      `SELECT DISTINCT player_id FROM battlecity_multiplayer_scores
       WHERE event_id = $1 AND validation_status = 'accepted'
         AND player_id = ANY($2::TEXT[])`,
      [tournamentId, normalized.map((item) => item.playerId)],
    );
    const eligible = new Set(eligibleResult.rows.map((row) => row.player_id));
    const ineligible = normalized.find((item) => !eligible.has(item.playerId));
    if (ineligible !== undefined) {
      throw createStoreError(
        'PLAYER_NOT_ELIGIBLE',
        `Player ${ineligible.playerId} has no accepted tournament score`,
      );
    }

    const now = new Date().toISOString();
    const distributions = [];
    const ledgerEntries = [];
    for (const allocation of normalized) {
      await database.getPool().query(
        `
          INSERT INTO battlecity_economy_accounts
            (player_id, provider, wallet_address, token_balance, sol_balance,
             fuel_balance, inventory_json, loadout_json, created_at, updated_at)
          SELECT id, provider, wallet_address, 1000, 1.25, 0, '{}'::JSONB,
            '{}'::JSONB, $2, $2
          FROM battlecity_players WHERE id = $1
          ON CONFLICT (player_id) DO NOTHING
        `,
        [allocation.playerId, now],
      );
      const balanceColumn = tournament.prizeCurrency === 'fuel'
        ? 'fuel_balance'
        : 'token_balance';
      await database.getPool().query(
        `UPDATE battlecity_economy_accounts
         SET ${balanceColumn} = ${balanceColumn} + $2, updated_at = $3
         WHERE player_id = $1`,
        [allocation.playerId, allocation.amount, now],
      );
      const distribution = {
        id: `tournament-prize-${crypto.randomBytes(12).toString('hex')}`,
        tournamentId,
        playerId: allocation.playerId,
        rank: allocation.rank,
        currency: tournament.prizeCurrency,
        amount: allocation.amount,
        distributedByPlayerId: adminPlayerId,
        distributedAt: now,
      };
      await database.getPool().query(
        `INSERT INTO battlecity_tournament_prize_distributions
          (id, tournament_id, player_id, rank, currency, amount,
           distributed_by_player_id, distributed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          distribution.id, distribution.tournamentId, distribution.playerId,
          distribution.rank, distribution.currency, distribution.amount,
          distribution.distributedByPlayerId, distribution.distributedAt,
        ],
      );
      distributions.push(distribution);
      ledgerEntries.push({
        playerId: allocation.playerId,
        currency: tournament.prizeCurrency,
        amount: allocation.amount,
        reason: 'tournament-prize',
        sourceType: 'tournament',
        sourceId: tournamentId,
        eventId: tournamentId,
      });
    }
    await ledgerStore.appendEntries(ledgerEntries);
    await database.getPool().query(
      `UPDATE battlecity_tournaments
       SET status = 'ended', prizes_distributed_at = $2,
         prizes_distributed_by_player_id = $3,
         updated_by_player_id = $3, updated_at = $2
       WHERE id = $1`,
      [tournamentId, now, adminPlayerId],
    );
    await database.getPool().query(
      `INSERT INTO battlecity_event_prize_approvals
        (event_id, allocations_json, approved_at)
       VALUES ($1, $2::JSONB, $3)
       ON CONFLICT (event_id) DO UPDATE SET
         allocations_json = EXCLUDED.allocations_json,
         approved_at = EXCLUDED.approved_at`,
      [tournamentId, JSON.stringify(normalized), now],
    );
    const updated = await getTournament(tournamentId);
    return { tournament: updated, distributions, alreadyDistributed: false };
  });
}

async function listDistributions(tournamentId) {
  const result = await database.getPool().query(
    `SELECT id, tournament_id, player_id, rank, currency, amount,
      distributed_by_player_id, distributed_at
     FROM battlecity_tournament_prize_distributions
     WHERE tournament_id = $1 ORDER BY rank, player_id`,
    [tournamentId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    tournamentId: row.tournament_id,
    playerId: row.player_id,
    rank: Number(row.rank),
    currency: row.currency,
    amount: Number(row.amount),
    distributedByPlayerId: row.distributed_by_player_id,
    distributedAt: new Date(row.distributed_at).toISOString(),
  }));
}

function normalizeInput(input, current) {
  const source = typeof input === 'object' && input !== null ? input : {};
  const name = normalizeText(source.name, current?.name || '', 80);
  if (name.length < 3) throw createStoreError('INVALID_TOURNAMENT', 'Name must be at least 3 characters');
  const slug = normalizeSlug(source.slug ?? current?.slug ?? name);
  const startsAt = normalizeDate(source.startsAt, current?.startsAt);
  const endsAt = normalizeDate(source.endsAt, current?.endsAt);
  if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    throw createStoreError('INVALID_TOURNAMENT', 'End time must be after start time');
  }
  const status = source.status ?? current?.status ?? 'draft';
  if (!STATUSES.has(status)) throw createStoreError('INVALID_TOURNAMENT', 'Invalid status');
  if (current === null && !EDITABLE_STATUSES.has(status)) {
    throw createStoreError('INVALID_TOURNAMENT', 'New tournaments must be draft, scheduled, or live');
  }
  const prizeCurrency = source.prizeCurrency ?? current?.prizeCurrency ?? 'token';
  if (!CURRENCIES.has(prizeCurrency)) throw createStoreError('INVALID_TOURNAMENT', 'Invalid prize currency');
  return {
    slug,
    name,
    description: normalizeText(source.description, current?.description || '', 600),
    status,
    startsAt,
    endsAt,
    entryFuelCost: requiredInteger(source.entryFuelCost, current?.entryFuelCost ?? 1, 0, 100000, 'entry fuel cost'),
    levelNumber: requiredInteger(source.levelNumber, current?.levelNumber ?? 1, 1, 35, 'level'),
    prizeCurrency,
    prizePool: requiredInteger(source.prizePool, current?.prizePool ?? 0, 0, Number.MAX_SAFE_INTEGER, 'prize pool'),
  };
}

function normalizeAllocations(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw createStoreError('INVALID_ALLOCATIONS', 'Provide between 1 and 100 prize allocations');
  }
  const seen = new Set();
  return value.map((item) => {
    const playerId = typeof item?.playerId === 'string' ? item.playerId.trim() : '';
    if (!/^ply-[a-z0-9-]+$/i.test(playerId) || seen.has(playerId)) {
      throw createStoreError('INVALID_ALLOCATIONS', 'Allocations require unique valid player IDs');
    }
    seen.add(playerId);
    return {
      playerId,
      rank: requiredInteger(item.rank, null, 1, 100000, 'rank'),
      amount: requiredInteger(item.amount, null, 1, Number.MAX_SAFE_INTEGER, 'amount'),
    };
  });
}

function effectiveStatus(tournament) {
  if (tournament.status === 'draft' || tournament.status === 'cancelled') return tournament.status;
  if (tournament.prizesDistributedAt !== null || Date.now() >= new Date(tournament.endsAt).getTime()) return 'ended';
  if (Date.now() >= new Date(tournament.startsAt).getTime()) return 'live';
  return 'scheduled';
}

function toEvent(tournament) {
  return {
    id: tournament.id,
    slug: tournament.slug,
    name: tournament.name,
    title: tournament.name,
    description: tournament.description,
    startsAt: tournament.startsAt,
    endsAt: tournament.endsAt,
    status: effectiveStatus(tournament) === 'scheduled'
      ? 'upcoming'
      : effectiveStatus(tournament),
    entryFuelCost: tournament.entryFuelCost,
    levelNumber: tournament.levelNumber,
    prizePool: `${tournament.prizePool.toLocaleString()} ${tournament.prizeCurrency === 'fuel' ? 'FUEL' : 'BACT'}`,
    prizeCurrency: tournament.prizeCurrency,
    rewardTracks: [],
    quests: [],
    source: 'admin-tournament',
  };
}

function fromRow(row) {
  const tournament = {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status,
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: new Date(row.ends_at).toISOString(),
    entryFuelCost: Number(row.entry_fuel_cost),
    levelNumber: Number(row.level_number),
    prizeCurrency: row.prize_currency,
    prizePool: Number(row.prize_pool),
    createdByPlayerId: row.created_by_player_id,
    updatedByPlayerId: row.updated_by_player_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    prizesDistributedAt: row.prizes_distributed_at == null ? null : new Date(row.prizes_distributed_at).toISOString(),
    prizesDistributedByPlayerId: row.prizes_distributed_by_player_id,
    participantCount: Number(row.participant_count || 0),
    matchCount: Number(row.match_count || 0),
    distributionCount: Number(row.distribution_count || 0),
  };
  tournament.effectiveStatus = effectiveStatus(tournament);
  return tournament;
}

function normalizeText(value, fallback, maxLength) {
  return (typeof value === 'string' ? value : fallback).trim().slice(0, maxLength);
}

function normalizeSlug(value) {
  const slug = String(value || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (slug.length < 3) throw createStoreError('INVALID_TOURNAMENT', 'Slug must be at least 3 characters');
  return slug;
}

function normalizeDate(value, fallback) {
  const date = new Date(value ?? fallback ?? '');
  if (!Number.isFinite(date.getTime())) throw createStoreError('INVALID_TOURNAMENT', 'Invalid tournament date');
  return date.toISOString();
}

function requiredInteger(value, fallback, min, max, label) {
  const parsed = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw createStoreError('INVALID_TOURNAMENT', `Invalid ${label}`);
  }
  return parsed;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function changesPrizeConfiguration(input, current) {
  return (
    (input?.prizeCurrency !== undefined
      && input.prizeCurrency !== current.prizeCurrency)
    || (input?.prizePool !== undefined
      && Number(input.prizePool) !== current.prizePool)
  );
}

function createStoreError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  createTournament,
  distributePrizes,
  findPublicEvent,
  getLeaderboard,
  getTournament,
  listDistributions,
  listPublicEvents,
  listTournaments,
  updateTournament,
};
