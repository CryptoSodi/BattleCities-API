const fs = require('fs').promises;
const path = require('path');
const storageConfig = require('../config/storageConfig');
const database = require('../database');

// Frozen leaderboard rows (plan: "Store snapshots so reward calculations
// cannot shift after a season closes"). Written once per (scope, season) by
// the season-close script; rankings served from a snapshot are immutable.

const TABLE_NAME = 'battlecity_leaderboard_rows';

function getDataDir() {
  return (
    process.env.BATTLECITY_SNAPSHOT_DIR ||
    path.join(process.cwd(), 'server-data', 'leaderboard-snapshots')
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

function getSnapshotPath(scope, seasonId) {
  return path.join(getDataDir(), `${scope}-${seasonId}.json`);
}

// Writes the frozen rows. Refuses to overwrite an existing snapshot — a
// closed season's board must never change.
async function writeSnapshot(scope, seasonId, rows) {
  const existing = await readSnapshot(scope, seasonId);
  if (existing !== null) {
    return { ok: false, error: 'Snapshot already exists' };
  }

  const snapshotAt = new Date().toISOString();
  const frozen = rows.map((row) => ({
    rank: row.rank,
    playerId: row.playerId,
    walletAddress: row.walletAddress || null,
    displayName: row.displayName,
    points: row.totalPoints,
    perks: Array.isArray(row.perks) ? row.perks : [],
    snapshotAt,
  }));

  if (hasPersistentConfig()) {
    await ensureSchema();
    for (const row of frozen) {
      await getPgPool().query(
        `
          INSERT INTO ${TABLE_NAME}
            (
              scope, season_id, rank, player_id, wallet_address,
              display_name, points, perk_badges_json, snapshot_at
            )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
          ON CONFLICT (scope, season_id, rank) DO NOTHING
        `,
        [
          scope,
          seasonId,
          row.rank,
          row.playerId,
          row.walletAddress,
          row.displayName,
          row.points,
          JSON.stringify(row.perks),
          row.snapshotAt,
        ],
      );
    }
    return { ok: true, rows: frozen.length };
  }

  await fs.mkdir(getDataDir(), { recursive: true });
  await fs.writeFile(
    getSnapshotPath(scope, seasonId),
    JSON.stringify(frozen),
    'utf8',
  );
  return { ok: true, rows: frozen.length };
}

async function readSnapshot(scope, seasonId) {
  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `
        SELECT rank, player_id, wallet_address, display_name, points,
          perk_badges_json, snapshot_at
        FROM ${TABLE_NAME}
        WHERE scope = $1 AND season_id = $2
        ORDER BY rank ASC
      `,
      [scope, seasonId],
    );

    if (result.rowCount === 0) {
      return null;
    }

    return result.rows.map((row) => ({
      rank: Number(row.rank),
      playerId: row.player_id,
      walletAddress: row.wallet_address,
      displayName: row.display_name,
      totalPoints: Number(row.points),
      perks: Array.isArray(row.perk_badges_json) ? row.perk_badges_json : [],
      snapshotAt: new Date(row.snapshot_at).toISOString(),
    }));
  }

  try {
    const raw = await fs.readFile(getSnapshotPath(scope, seasonId), 'utf8');
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) {
      return null;
    }
    return rows.map((row) => ({
      rank: row.rank,
      playerId: row.playerId,
      walletAddress: row.walletAddress,
      displayName: row.displayName,
      totalPoints: row.points,
      perks: Array.isArray(row.perks) ? row.perks : [],
      snapshotAt: row.snapshotAt,
    }));
  } catch {
    return null;
  }
}

module.exports = {
  readSnapshot,
  writeSnapshot,
  isPersistentStoreConfigured: hasPersistentConfig,
};
