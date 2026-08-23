const crypto = require('crypto');
const database = require('../database');
const storageConfig = require('../config/storageConfig');
const economyStore = require('./economyStore');
const playerStore = require('./playerStore');

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DISCORD_FOLLOW_FUEL_REWARD = 5;
const localByPlayerId = new Map();
const localPlayerIdByDiscordUserId = new Map();
const localRewardedPlayerIds = new Set();

function hasPersistentConfig() {
  return storageConfig.hasDatabaseConfig();
}

function normalizeCode(value) {
  const code = String(value || '')
    .trim()
    .toUpperCase();
  return /^BC-[A-Z2-9]{8}$/.test(code) ? code : null;
}

function hashCode(code) {
  return crypto
    .createHash('sha256')
    .update(code)
    .digest('hex');
}

function createCode() {
  const bytes = crypto.randomBytes(8);
  let value = 'BC-';
  for (const byte of bytes) {
    value += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return value;
}

function toPublicState(record) {
  return {
    verified: record?.verifiedAt !== null && record?.verifiedAt !== undefined,
    discordUsername: record?.discordUsername || null,
    verifiedAt: record?.verifiedAt || null,
    rewardClaimed: Boolean(record?.rewardClaimed),
    expiresAt:
      record?.verifiedAt === null || record?.verifiedAt === undefined
        ? record?.codeExpiresAt || null
        : null,
  };
}

async function readVerification(playerId) {
  if (!hasPersistentConfig()) {
    return toPublicState(localByPlayerId.get(playerId) || null);
  }

  await database.assertMigrationsApplied();
  const result = await database.getPool().query(
    `SELECT v.discord_username, v.code_expires_at, v.verified_at,
       EXISTS(
         SELECT 1 FROM battlecity_discord_follow_rewards r
         WHERE r.player_id = v.player_id
       ) AS reward_claimed
       FROM battlecity_discord_verifications
       v WHERE v.player_id = $1`,
    [playerId],
  );
  return toPublicState(
    result.rows[0]
      ? {
          discordUsername: result.rows[0].discord_username,
          codeExpiresAt: toIso(result.rows[0].code_expires_at),
          verifiedAt: toIso(result.rows[0].verified_at),
          rewardClaimed: result.rows[0].reward_claimed,
        }
      : null,
  );
}

async function isDiscordUserVerified(discordUserId) {
  if (!isValidDiscordUserId(discordUserId)) {
    return false;
  }

  if (!hasPersistentConfig()) {
    const playerId = localPlayerIdByDiscordUserId.get(discordUserId);
    return Boolean(playerId && localByPlayerId.get(playerId)?.verifiedAt);
  }

  await database.assertMigrationsApplied();
  const result = await database.getPool().query(
    `SELECT 1
       FROM battlecity_discord_verifications
       WHERE discord_user_id = $1 AND verified_at IS NOT NULL
       LIMIT 1`,
    [discordUserId],
  );
  return result.rows.length > 0;
}

async function createVerificationCode(playerId) {
  if (!hasPersistentConfig()) {
    return createLocalVerificationCode(playerId);
  }

  await database.assertMigrationsApplied();
  return database.withTransaction(async () => {
    const existing = await database.getPool().query(
      `SELECT verified_at FROM battlecity_discord_verifications
       WHERE player_id = $1 FOR UPDATE`,
      [playerId],
    );
    if (existing.rows[0]?.verified_at) {
      return { ok: false, error: 'Discord is already verified' };
    }

    const code = createCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
    await database.getPool().query(
      `INSERT INTO battlecity_discord_verifications
         (player_id, code_hash, code_expires_at, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (player_id) DO UPDATE SET
         code_hash = EXCLUDED.code_hash,
         code_expires_at = EXCLUDED.code_expires_at,
         updated_at = NOW()`,
      [playerId, hashCode(code), expiresAt],
    );
    return { ok: true, code, expiresAt };
  });
}

async function verifyCode(code, discordUserId, discordUsername) {
  const normalizedCode = normalizeCode(code);
  if (normalizedCode === null || !isValidDiscordUserId(discordUserId)) {
    return { ok: false, error: 'That verification code is invalid or expired' };
  }

  if (!hasPersistentConfig()) {
    return verifyLocalCode(normalizedCode, discordUserId, discordUsername);
  }

  await database.assertMigrationsApplied();
  return database.withTransaction(async () => {
    const pool = database.getPool();
    const codeResult = await pool.query(
      `SELECT player_id, verified_at
       FROM battlecity_discord_verifications
       WHERE code_hash = $1 AND code_expires_at > NOW()
       FOR UPDATE`,
      [hashCode(normalizedCode)],
    );
    const codeRecord = codeResult.rows[0];
    if (!codeRecord) {
      return {
        ok: false,
        error: 'That verification code is invalid or expired',
      };
    }

    const linkedResult = await pool.query(
      `SELECT player_id FROM battlecity_discord_verifications
       WHERE discord_user_id = $1 FOR UPDATE`,
      [discordUserId],
    );
    const linkedPlayerId = linkedResult.rows[0]?.player_id || null;
    if (linkedPlayerId !== null && linkedPlayerId !== codeRecord.player_id) {
      return {
        ok: false,
        error: 'This Discord account is already verified to another player',
      };
    }

    const verifiedAt = new Date().toISOString();
    await pool.query(
      `UPDATE battlecity_discord_verifications
       SET discord_user_id = $1,
           discord_username = $2,
           code_hash = NULL,
           code_expires_at = NULL,
           verified_at = $3,
           updated_at = NOW()
       WHERE player_id = $4`,
      [
        discordUserId,
        normalizeDiscordUsername(discordUsername),
        verifiedAt,
        codeRecord.player_id,
      ],
    );
    const rewardGranted = await grantFollowReward(
      codeRecord.player_id,
      discordUserId,
    );
    return { ok: true, playerId: codeRecord.player_id, verifiedAt, rewardGranted };
  });
}

async function verifyDiscordAccount(playerId, discordUserId, discordUsername) {
  if (!isValidDiscordUserId(discordUserId)) {
    return { ok: false, error: 'Invalid Discord account' };
  }

  if (!hasPersistentConfig()) {
    return verifyLocalDiscordAccount(playerId, discordUserId, discordUsername);
  }

  await database.assertMigrationsApplied();
  return database.withTransaction(async () => {
    const pool = database.getPool();
    const linkedResult = await pool.query(
      `SELECT player_id FROM battlecity_discord_verifications
       WHERE discord_user_id = $1 FOR UPDATE`,
      [discordUserId],
    );
    const linkedPlayerId = linkedResult.rows[0]?.player_id || null;
    if (linkedPlayerId !== null && linkedPlayerId !== playerId) {
      return {
        ok: false,
        error: 'This Discord account is already verified to another player',
      };
    }

    const verifiedAt = new Date().toISOString();
    await pool.query(
      `INSERT INTO battlecity_discord_verifications
         (player_id, discord_user_id, discord_username, verified_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (player_id) DO UPDATE SET
         discord_user_id = EXCLUDED.discord_user_id,
         discord_username = EXCLUDED.discord_username,
         code_hash = NULL,
         code_expires_at = NULL,
         verified_at = EXCLUDED.verified_at,
         updated_at = NOW()`,
      [
        playerId,
        discordUserId,
        normalizeDiscordUsername(discordUsername),
        verifiedAt,
      ],
    );
    const rewardGranted = await grantFollowReward(playerId, discordUserId);
    return { ok: true, playerId, verifiedAt, rewardGranted };
  });
}

async function claimFollowReward(player) {
  if (!player?.id) return { ok: false, error: 'Invalid player' };
  if (!hasPersistentConfig()) {
    const record = localByPlayerId.get(player.id);
    if (!record?.verifiedAt || !record.discordUserId) {
      return { ok: false, error: 'Discord membership has not been verified' };
    }
    return { ok: true, granted: await grantLocalFollowReward(player.id) };
  }

  await database.assertMigrationsApplied();
  return database.withTransaction(async () => {
    const result = await database.getPool().query(
      `SELECT discord_user_id FROM battlecity_discord_verifications
       WHERE player_id = $1 AND verified_at IS NOT NULL FOR UPDATE`,
      [player.id],
    );
    const discordUserId = result.rows[0]?.discord_user_id;
    if (!discordUserId) {
      return { ok: false, error: 'Discord membership has not been verified' };
    }
    return { ok: true, granted: await grantFollowReward(player.id, discordUserId) };
  });
}

function createLocalVerificationCode(playerId) {
  const existing = localByPlayerId.get(playerId);
  if (existing?.verifiedAt) {
    return { ok: false, error: 'Discord is already verified' };
  }

  const code = createCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
  localByPlayerId.set(playerId, {
    codeHash: hashCode(code),
    codeExpiresAt: expiresAt,
    discordUserId: null,
    discordUsername: null,
    verifiedAt: null,
  });
  return { ok: true, code, expiresAt };
}

async function verifyLocalCode(code, discordUserId, discordUsername) {
  const linkedPlayerId = localPlayerIdByDiscordUserId.get(discordUserId);
  if (linkedPlayerId) {
    return {
      ok: false,
      error: 'This Discord account is already verified to another player',
    };
  }

  const expectedHash = hashCode(code);
  const entry = Array.from(localByPlayerId.entries()).find(
    ([, record]) =>
      record.codeHash === expectedHash &&
      new Date(record.codeExpiresAt).getTime() > Date.now(),
  );
  if (!entry) {
    return { ok: false, error: 'That verification code is invalid or expired' };
  }

  const [playerId, record] = entry;
  const verifiedAt = new Date().toISOString();
  record.codeHash = null;
  record.codeExpiresAt = null;
  record.discordUserId = discordUserId;
  record.discordUsername = normalizeDiscordUsername(discordUsername);
  record.verifiedAt = verifiedAt;
  localPlayerIdByDiscordUserId.set(discordUserId, playerId);
  const rewardGranted = await grantLocalFollowReward(playerId);
  return { ok: true, playerId, verifiedAt, rewardGranted };
}

async function verifyLocalDiscordAccount(playerId, discordUserId, discordUsername) {
  const linkedPlayerId = localPlayerIdByDiscordUserId.get(discordUserId);
  if (linkedPlayerId && linkedPlayerId !== playerId) {
    return {
      ok: false,
      error: 'This Discord account is already verified to another player',
    };
  }

  const verifiedAt = new Date().toISOString();
  localByPlayerId.set(playerId, {
    codeHash: null,
    codeExpiresAt: null,
    discordUserId,
    discordUsername: normalizeDiscordUsername(discordUsername),
    verifiedAt,
  });
  localPlayerIdByDiscordUserId.set(discordUserId, playerId);
  const rewardGranted = await grantLocalFollowReward(playerId);
  return { ok: true, playerId, verifiedAt, rewardGranted };
}

async function grantFollowReward(playerId, discordUserId) {
  const receipt = await database.getPool().query(
    `INSERT INTO battlecity_discord_follow_rewards
       (player_id, discord_user_id, fuel_amount)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING player_id`,
    [playerId, discordUserId, DISCORD_FOLLOW_FUEL_REWARD],
  );
  if (receipt.rowCount === 0) return false;
  const player = await playerStore.readPlayer(playerId);
  if (player === null) throw new Error('Verified player no longer exists');
  await economyStore.creditFuel(player, DISCORD_FOLLOW_FUEL_REWARD, {
    reason: 'discord-follow-reward',
    sourceType: 'discord-follow-reward',
    sourceId: 'first-guild-verification',
  });
  return true;
}

async function grantLocalFollowReward(playerId) {
  if (localRewardedPlayerIds.has(playerId)) return false;
  const player = await playerStore.readPlayer(playerId);
  if (player === null) return false;
  await economyStore.creditFuel(player, DISCORD_FOLLOW_FUEL_REWARD, {
    reason: 'discord-follow-reward',
    sourceType: 'discord-follow-reward',
    sourceId: 'first-guild-verification',
  });
  localRewardedPlayerIds.add(playerId);
  const record = localByPlayerId.get(playerId);
  if (record) record.rewardClaimed = true;
  return true;
}

function normalizeDiscordUsername(value) {
  const name = String(value || '').trim();
  return name.slice(0, 100) || null;
}

function isValidDiscordUserId(value) {
  return /^\d{16,22}$/.test(String(value || ''));
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : value || null;
}

module.exports = {
  createVerificationCode,
  claimFollowReward,
  isDiscordUserVerified,
  readVerification,
  verifyDiscordAccount,
  verifyCode,
};
