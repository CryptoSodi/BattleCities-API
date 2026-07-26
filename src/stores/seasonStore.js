const fs = require('fs').promises;
const path = require('path');
const storageConfig = require('../config/storageConfig');
const database = require('../database');

// Seasons are first-class server records (see the plan's "Ranking, Seasons,
// Phases"). A season is a fixed reward window; rankings and match results
// attach to a season id so leaderboards can't shift after a season closes.
//
// The store self-seeds: if "now" falls outside every stored season, a new
// 30-day season is created automatically (Season N), so dev and production
// always have a current season without a manual admin step.

const TABLE_NAME = 'battlecity_seasons';
const SEASON_LENGTH_DAYS = 30;

function getDataDir() {
  return (
    process.env.BATTLECITY_SEASON_DIR ||
    path.join(process.cwd(), 'server-data', 'seasons')
  );
}

function getSeasonsPath() {
  return path.join(getDataDir(), 'seasons.json');
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

async function listSeasons() {
  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `
        SELECT id, number, name, starts_at, ends_at, status, reward_pool,
          created_at
        FROM ${TABLE_NAME}
        ORDER BY number DESC
      `,
    );
    return result.rows.map(fromRow);
  }

  try {
    const raw = await fs.readFile(getSeasonsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter(isValidSeason)
      .sort((a, b) => b.number - a.number);
  } catch {
    return [];
  }
}

// Returns the season containing "now", creating and persisting the next one
// when no stored season covers the current time.
async function getCurrentSeason() {
  const seasons = await listSeasons();
  const now = Date.now();

  const active = seasons.find((season) => {
    return (
      Date.parse(season.startsAt) <= now && now < Date.parse(season.endsAt)
    );
  });
  if (active !== undefined) {
    return active;
  }

  const lastNumber = seasons.length > 0 ? seasons[0].number : 0;
  const season = createSeasonRecord(lastNumber + 1, seasons);

  await writeSeason(season, seasons);
  return season;
}

async function readSeason(seasonId) {
  if (typeof seasonId !== 'string' || seasonId === '') {
    return null;
  }

  const seasons = await listSeasons();
  return seasons.find((season) => season.id === seasonId) || null;
}

function createSeasonRecord(number, existingSeasons) {
  const now = new Date();

  // A new season starts where the previous one ended when that end is in the
  // past-but-recent, otherwise it starts today (midnight UTC) — avoids
  // creating a backlog of empty filler seasons after long downtime.
  let startsAt = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  if (existingSeasons.length > 0) {
    const lastEnd = Date.parse(existingSeasons[0].endsAt);
    if (lastEnd <= now.getTime() && now.getTime() - lastEnd < 24 * 3600 * 1000) {
      startsAt = new Date(lastEnd);
    }
  }

  const endsAt = new Date(
    startsAt.getTime() + SEASON_LENGTH_DAYS * 24 * 3600 * 1000,
  );

  return {
    id: `season-${number}`,
    number,
    name: `Season ${number}`,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    status: 'live',
    rewardPool: null,
    createdAt: new Date().toISOString(),
  };
}

async function writeSeason(season, existingSeasons) {
  if (hasPersistentConfig()) {
    await ensureSchema();
    await getPgPool().query(
      `
        INSERT INTO ${TABLE_NAME}
          (id, number, name, starts_at, ends_at, status, reward_pool, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO NOTHING
      `,
      [
        season.id,
        season.number,
        season.name,
        season.startsAt,
        season.endsAt,
        season.status,
        season.rewardPool,
        season.createdAt,
      ],
    );
    return;
  }

  await fs.mkdir(getDataDir(), { recursive: true });
  const all = [...existingSeasons, season];
  await fs.writeFile(getSeasonsPath(), JSON.stringify(all), 'utf8');
}

function toPublicSeason(season) {
  return {
    id: season.id,
    number: season.number,
    name: season.name,
    startsAt: season.startsAt,
    endsAt: season.endsAt,
    status: resolveStatus(season),
    rewardPool: season.rewardPool,
  };
}

function resolveStatus(season) {
  const now = Date.now();
  if (now < Date.parse(season.startsAt)) {
    return 'upcoming';
  }
  if (now >= Date.parse(season.endsAt)) {
    return 'ended';
  }
  return 'live';
}

function fromRow(row) {
  return {
    id: row.id,
    number: Number(row.number),
    name: row.name,
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: new Date(row.ends_at).toISOString(),
    status: row.status,
    rewardPool: row.reward_pool,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function isValidSeason(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.id === 'string' &&
    Number.isInteger(value.number) &&
    typeof value.name === 'string' &&
    typeof value.startsAt === 'string' &&
    typeof value.endsAt === 'string'
  );
}

module.exports = {
  getCurrentSeason,
  listSeasons,
  readSeason,
  toPublicSeason,
  isPersistentStoreConfigured: hasPersistentConfig,
};
