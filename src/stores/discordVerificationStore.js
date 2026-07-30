const crypto = require('crypto');
const database = require('../database');
const storageConfig = require('../config/storageConfig');

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const localByPlayerId = new Map();
const localPlayerIdByDiscordUserId = new Map();

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
  return crypto.createHash('sha256').update(code).digest('hex');
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
    `SELECT discord_username, code_expires_at, verified_at
       FROM battlecity_discord_verifications
       WHERE player_id = $1`,
    [playerId],
  );
  return toPublicState(
    result.rows[0]
      ? {
          discordUsername: result.rows[0].discord_username,
          codeExpiresAt: toIso(result.rows[0].code_expires_at),
          verifiedAt: toIso(result.rows[0].verified_at),
        }
      : null,
  );
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
      return { ok: false, error: 'That verification code is invalid or expired' };
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
      [discordUserId, normalizeDiscordUsername(discordUsername), verifiedAt, codeRecord.player_id],
    );
    return { ok: true, playerId: codeRecord.player_id, verifiedAt };
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

function verifyLocalCode(code, discordUserId, discordUsername) {
  const linkedPlayerId = localPlayerIdByDiscordUserId.get(discordUserId);
  if (linkedPlayerId) {
    return {
      ok: false,
      error: 'This Discord account is already verified to another player',
    };
  }

  const expectedHash = hashCode(code);
  const entry = Array.from(localByPlayerId.entries()).find(([, record]) =>
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
  return { ok: true, playerId, verifiedAt };
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
  readVerification,
  verifyCode,
};
