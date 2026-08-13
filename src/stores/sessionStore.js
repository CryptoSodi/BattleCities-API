const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const playerStore = require('./playerStore');
const storageConfig = require('../config/storageConfig');
const database = require('../database');

const TABLE_NAME = 'battlecity_sessions';

function getDataDir() {
  return (
    process.env.BATTLECITY_SESSION_DIR ||
    path.join(process.cwd(), 'server-data', 'sessions')
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

async function ensureDataDir() {
  await fs.mkdir(getDataDir(), { recursive: true });
}

function getSessionPath(id) {
  return path.join(getDataDir(), `${id}.json`);
}

async function createWalletSession(walletAddress) {
  if (!isValidWalletAddress(walletAddress)) {
    throw new Error('Invalid wallet address');
  }

  const player = await playerStore.findOrCreateWalletPlayer(walletAddress);
  return createSession('wallet', {
    playerId: player.id,
    walletAddress,
  });
}

async function createGoogleSession(profile) {
  if (!isValidGoogleProfile(profile)) {
    throw new Error('Invalid Google profile');
  }

  const player = await playerStore.findOrCreateGooglePlayer(profile);
  return createSession('google', {
    playerId: player.id,
    googleProfile: profile,
  });
}

async function createSession(provider, identity) {
  const googleProfile = identity.googleProfile || null;
  const now = new Date().toISOString();
  const session = {
    id: createSessionId(),
    provider,
    createdAt: now,
    lastSeenAt: now,
    playerId: identity.playerId,
    walletAddress: identity.walletAddress || null,
    googleSubject: googleProfile?.sub || null,
    googleEmail: googleProfile?.email || null,
    googleName: googleProfile?.name || null,
    googlePicture: googleProfile?.picture || null,
  };

  if (hasPersistentConfig()) {
    await ensureSchema();
    await getPgPool().query(
      `
        INSERT INTO ${TABLE_NAME}
          (
            id,
            provider,
            created_at,
            last_seen_at,
            player_id,
            wallet_address,
            google_subject,
            google_email,
            google_name,
            google_picture
          )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        session.id,
        session.provider,
        session.createdAt,
        session.lastSeenAt,
        session.playerId,
        session.walletAddress,
        session.googleSubject,
        session.googleEmail,
        session.googleName,
        session.googlePicture,
      ],
    );
    return session;
  }

  await ensureDataDir();
  await fs.writeFile(getSessionPath(session.id), JSON.stringify(session), 'utf8');

  return session;
}

async function readSession(id) {
  if (!isValidSessionId(id)) {
    return null;
  }

  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `
        SELECT id, provider, created_at, last_seen_at, player_id
          , wallet_address, google_subject, google_email, google_name
          , google_picture
        FROM ${TABLE_NAME}
        WHERE id = $1
        LIMIT 1
      `,
      [id],
    );

    if (result.rowCount === 0) {
      return null;
    }

    const row = result.rows[0];
    const session = {
      id: row.id,
      provider: row.provider,
      createdAt: new Date(row.created_at).toISOString(),
      lastSeenAt: new Date(row.last_seen_at).toISOString(),
      playerId: row.player_id,
      walletAddress: row.wallet_address,
      googleSubject: row.google_subject,
      googleEmail: row.google_email,
      googleName: row.google_name,
      googlePicture: row.google_picture,
    };
    if (!isValidSession(session)) {
      return null;
    }
    await touchSession(session.id);
    return session;
  }

  try {
    const raw = await fs.readFile(getSessionPath(id), 'utf8');
    const session = JSON.parse(raw);
    if (!isValidSession(session)) {
      return null;
    }
    await touchSession(session.id);
    return session;
  } catch {
    return null;
  }
}

async function deleteSession(id) {
  if (!isValidSessionId(id)) {
    return;
  }

  if (hasPersistentConfig()) {
    await ensureSchema();
    await getPgPool().query(`DELETE FROM ${TABLE_NAME} WHERE id = $1`, [id]);
    return;
  }

  try {
    await fs.unlink(getSessionPath(id));
  } catch {
    // Session is already gone.
  }
}

async function touchSession(id) {
  const lastSeenAt = new Date().toISOString();

  if (hasPersistentConfig()) {
    await getPgPool().query(
      `UPDATE ${TABLE_NAME} SET last_seen_at = $1 WHERE id = $2`,
      [lastSeenAt, id],
    );
    return;
  }

  try {
    const raw = await fs.readFile(getSessionPath(id), 'utf8');
    const session = JSON.parse(raw);
    session.lastSeenAt = lastSeenAt;
    await fs.writeFile(getSessionPath(id), JSON.stringify(session), 'utf8');
  } catch {
    // Best-effort only; readSession still controls validity.
  }
}

function toPublicSession(session) {
  return {
    authenticated: true,
    provider: session.provider,
    playerId: session.playerId,
    walletAddress: session.walletAddress || null,
    googleEmail: session.googleEmail || null,
    googleName: session.googleName || null,
    googlePicture: session.googlePicture || null,
    createdAt: session.createdAt,
  };
}

function createSessionId() {
  return `sess-${Date.now().toString(36)}-${crypto
    .randomBytes(12)
    .toString('hex')}`;
}

function isValidSessionId(value) {
  return typeof value === 'string' && /^sess-[a-z0-9-]+$/i.test(value);
}

function isValidSession(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    isValidSessionId(value.id) &&
    (value.provider === 'wallet' || value.provider === 'google') &&
    typeof value.createdAt === 'string' &&
    typeof value.lastSeenAt === 'string' &&
    (value.walletAddress === null ||
      typeof value.walletAddress === 'undefined' ||
      isValidWalletAddress(value.walletAddress))
  );
}

function isValidGoogleProfile(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.sub === 'string' &&
    value.sub.length > 0 &&
    (typeof value.email === 'string' || typeof value.email === 'undefined') &&
    (typeof value.name === 'string' || typeof value.name === 'undefined') &&
    (typeof value.picture === 'string' || typeof value.picture === 'undefined')
  );
}

function isValidWalletAddress(value) {
  return (
    typeof value === 'string' &&
    value.length >= 32 &&
    value.length <= 64 &&
    /^[1-9A-HJ-NP-Za-km-z]+$/.test(value)
  );
}

module.exports = {
  createGoogleSession,
  createWalletSession,
  deleteSession,
  isPersistentStoreConfigured: hasPersistentConfig,
  isValidWalletAddress,
  readSession,
  toPublicSession,
};
