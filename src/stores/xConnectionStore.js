const database = require('../database');
const storageConfig = require('../config/storageConfig');
const economyStore = require('./economyStore');

const localByPlayerId = new Map();
const localPlayerIdByXUserId = new Map();
const localFollowRewardsByPlayerId = new Set();
const X_FOLLOW_FUEL_REWARD = 5;

function hasPersistentConfig() {
  return storageConfig.hasDatabaseConfig();
}

async function readConnection(playerId) {
  if (!hasPersistentConfig()) return toPublicState(localByPlayerId.get(playerId) || null);
  await database.assertMigrationsApplied();
  const result = await database.getPool().query(
    `SELECT x_username, connected_at, follows_battlecities, followed_checked_at
     FROM battlecity_x_connections WHERE player_id = $1`,
    [playerId],
  );
  return toPublicState(result.rows[0] || null);
}

async function readLinkedAccount(playerId) {
  if (!hasPersistentConfig()) return localByPlayerId.get(playerId) || null;
  await database.assertMigrationsApplied();
  const result = await database.getPool().query(
    `SELECT x_user_id, x_username, connected_at, follows_battlecities, followed_checked_at
     FROM battlecity_x_connections WHERE player_id = $1`,
    [playerId],
  );
  return result.rows[0] || null;
}

async function linkAccount(playerId, xUserId, xUsername) {
  if (!/^\d{1,20}$/.test(String(xUserId || ''))) return { ok: false, error: 'Invalid X account' };
  if (!hasPersistentConfig()) return linkLocalAccount(playerId, xUserId, xUsername);
  await database.assertMigrationsApplied();
  return database.withTransaction(async () => {
    const pool = database.getPool();
    const linked = await pool.query(
      'SELECT player_id FROM battlecity_x_connections WHERE x_user_id = $1 FOR UPDATE',
      [xUserId],
    );
    if (linked.rows[0]?.player_id && linked.rows[0].player_id !== playerId) {
      return { ok: false, error: 'This X account is already linked to another player' };
    }
    await pool.query(
      `INSERT INTO battlecity_x_connections (player_id, x_user_id, x_username, connected_at, follows_battlecities, followed_checked_at, updated_at)
       VALUES ($1, $2, $3, NOW(), FALSE, NULL, NOW())
       ON CONFLICT (player_id) DO UPDATE SET
         x_user_id = EXCLUDED.x_user_id,
         x_username = EXCLUDED.x_username,
         connected_at = NOW(),
         follows_battlecities = FALSE,
         followed_checked_at = NULL,
         updated_at = NOW()`,
      [playerId, xUserId, normalizeUsername(xUsername)],
    );
    return { ok: true };
  });
}

async function recordFollowCheck(playerId, follows) {
  if (!hasPersistentConfig()) {
    const entry = localByPlayerId.get(playerId);
    if (entry) {
      entry.followsBattlecities = Boolean(follows);
      entry.followedCheckedAt = new Date().toISOString();
    }
    return;
  }
  await database.assertMigrationsApplied();
  await database.getPool().query(
    `UPDATE battlecity_x_connections
     SET follows_battlecities = $1, followed_checked_at = NOW(), updated_at = NOW()
     WHERE player_id = $2`,
    [Boolean(follows), playerId],
  );
}

async function unlinkAccount(playerId) {
  if (!hasPersistentConfig()) {
    const entry = localByPlayerId.get(playerId) || null;
    if (entry?.xUserId) localPlayerIdByXUserId.delete(entry.xUserId);
    localByPlayerId.delete(playerId);
    return { disconnected: entry !== null };
  }

  await database.assertMigrationsApplied();
  const result = await database.getPool().query(
    'DELETE FROM battlecity_x_connections WHERE player_id = $1 RETURNING player_id',
    [playerId],
  );
  return { disconnected: result.rowCount !== 0 };
}

async function recordFollowCheckAndGrantReward(player, xUserId, follows) {
  if (!follows) {
    await recordFollowCheck(player.id, false);
    return { granted: false };
  }

  if (!hasPersistentConfig()) {
    await recordFollowCheck(player.id, true);
    if (localFollowRewardsByPlayerId.has(player.id)) return { granted: false };
    await creditFirstFollowFuel(player);
    localFollowRewardsByPlayerId.add(player.id);
    return { granted: true };
  }

  await database.assertMigrationsApplied();
  return database.withTransaction(async () => {
    const pool = database.getPool();
    const updated = await pool.query(
      `UPDATE battlecity_x_connections
       SET follows_battlecities = TRUE, followed_checked_at = NOW(), updated_at = NOW()
       WHERE player_id = $1
       RETURNING player_id`,
      [player.id],
    );
    if (updated.rowCount === 0) return { granted: false };
    const receipt = await pool.query(
      `INSERT INTO battlecity_x_follow_rewards (player_id, x_user_id, fuel_amount)
       VALUES ($1, $2, $3)
       ON CONFLICT (player_id) DO NOTHING
       RETURNING player_id`,
      [player.id, xUserId, X_FOLLOW_FUEL_REWARD],
    );
    if (receipt.rowCount === 0) return { granted: false };
    await creditFirstFollowFuel(player);
    return { granted: true };
  });
}

function creditFirstFollowFuel(player) {
  return economyStore.creditFuel(player, X_FOLLOW_FUEL_REWARD, {
    reason: 'x-follow-reward',
    sourceType: 'x-follow-reward',
    sourceId: 'first-follow',
  });
}

function linkLocalAccount(playerId, xUserId, xUsername) {
  const linkedPlayerId = localPlayerIdByXUserId.get(xUserId);
  if (linkedPlayerId && linkedPlayerId !== playerId) return { ok: false, error: 'This X account is already linked to another player' };
  const old = localByPlayerId.get(playerId);
  if (old?.xUserId && old.xUserId !== xUserId) localPlayerIdByXUserId.delete(old.xUserId);
  localByPlayerId.set(playerId, {
    xUserId,
    xUsername: normalizeUsername(xUsername),
    connectedAt: new Date().toISOString(),
    followsBattlecities: false,
    followedCheckedAt: null,
  });
  localPlayerIdByXUserId.set(xUserId, playerId);
  return { ok: true };
}

function toPublicState(record) {
  return {
    connected: Boolean(record),
    xUsername: record?.x_username || record?.xUsername || null,
    connectedAt: toIso(record?.connected_at || record?.connectedAt),
    follows: Boolean(record?.follows_battlecities ?? record?.followsBattlecities),
    followedCheckedAt: toIso(record?.followed_checked_at || record?.followedCheckedAt),
  };
}

function normalizeUsername(value) {
  return String(value || '').trim().replace(/^@/, '').slice(0, 15);
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : value || null;
}

module.exports = {
  X_FOLLOW_FUEL_REWARD,
  linkAccount,
  unlinkAccount,
  readConnection,
  readLinkedAccount,
  recordFollowCheck,
  recordFollowCheckAndGrantReward,
};
