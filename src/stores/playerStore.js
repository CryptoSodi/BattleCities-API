const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const storageConfig = require('../config/storageConfig');
const database = require('../database');

const TABLE_NAME = 'battlecity_players';

function getDataDir() {
  return (
    process.env.BATTLECITY_PLAYER_DIR ||
    path.join(process.cwd(), 'server-data', 'players')
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

function getPlayerPath(id) {
  return path.join(getDataDir(), `${id}.json`);
}

async function findOrCreateWalletPlayer(walletAddress) {
  if (!isValidWalletAddress(walletAddress)) {
    throw new Error('Invalid wallet address');
  }

  const existing = await findByIdentity('walletAddress', walletAddress);
  if (existing !== null) {
    await touchPlayer(existing.id);
    return existing;
  }

  return createPlayer({
    provider: 'wallet',
    displayName: shortenWallet(walletAddress),
    walletAddress,
  });
}

async function findOrCreateGooglePlayer(profile) {
  if (!isValidGoogleProfile(profile)) {
    throw new Error('Invalid Google profile');
  }

  const existing = await findByIdentity('googleSubject', profile.sub);
  if (existing !== null) {
    const updated = {
      ...existing,
      displayName: profile.name || existing.displayName,
      googleEmail: profile.email || existing.googleEmail,
      googleName: profile.name || existing.googleName,
      googlePicture: profile.picture || existing.googlePicture,
    };
    await updatePlayer(updated);
    return updated;
  }

  return createPlayer({
    provider: 'google',
    displayName: profile.name || 'Google Player',
    googleSubject: profile.sub,
    googleEmail: profile.email || null,
    googleName: profile.name || null,
    googlePicture: profile.picture || null,
  });
}

async function readPlayer(id) {
  if (!isValidPlayerId(id)) {
    return null;
  }

  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `
        SELECT id, provider, display_name, created_at, updated_at,
          last_seen_at, wallet_address, google_subject, google_email,
          google_name, google_picture, highscore_primary, highscore_secondary
        FROM ${TABLE_NAME}
        WHERE id = $1
        LIMIT 1
      `,
      [id],
    );

    if (result.rowCount === 0) {
      return null;
    }

    const player = fromRow(result.rows[0]);
    return isValidPlayer(player) ? player : null;
  }

  try {
    const raw = await fs.readFile(getPlayerPath(id), 'utf8');
    const player = JSON.parse(raw);
    return isValidPlayer(player) ? normalizePlayer(player) : null;
  } catch {
    return null;
  }
}

async function createPlayer(input) {
  const now = new Date().toISOString();
  const player = {
    id: createPlayerId(),
    provider: input.provider,
    displayName: input.displayName,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    walletAddress: input.walletAddress || null,
    googleSubject: input.googleSubject || null,
    googleEmail: input.googleEmail || null,
    googleName: input.googleName || null,
    googlePicture: input.googlePicture || null,
    highscorePrimary: 0,
    highscoreSecondary: 0,
  };

  if (hasPersistentConfig()) {
    await ensureSchema();
    await getPgPool().query(
      `
        INSERT INTO ${TABLE_NAME}
          (
            id,
            provider,
            display_name,
            created_at,
            updated_at,
            last_seen_at,
            wallet_address,
            google_subject,
            google_email,
            google_name,
            google_picture
          )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        player.id,
        player.provider,
        player.displayName,
        player.createdAt,
        player.updatedAt,
        player.lastSeenAt,
        player.walletAddress,
        player.googleSubject,
        player.googleEmail,
        player.googleName,
        player.googlePicture,
      ],
    );
    return player;
  }

  await ensureDataDir();
  await fs.writeFile(getPlayerPath(player.id), JSON.stringify(player), 'utf8');

  return player;
}

async function findByIdentity(field, value) {
  if (typeof value !== 'string' || value === '') {
    return null;
  }

  if (hasPersistentConfig()) {
    await ensureSchema();
    const column = field === 'walletAddress' ? 'wallet_address' : 'google_subject';
    const result = await getPgPool().query(
      `
        SELECT id, provider, display_name, created_at, updated_at,
          last_seen_at, wallet_address, google_subject, google_email,
          google_name, google_picture, highscore_primary, highscore_secondary
        FROM ${TABLE_NAME}
        WHERE ${column} = $1
        LIMIT 1
      `,
      [value],
    );

    return result.rowCount === 0 ? null : fromRow(result.rows[0]);
  }

  await ensureDataDir();
  const files = await fs.readdir(getDataDir());
  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue;
    }

    try {
      const raw = await fs.readFile(path.join(getDataDir(), file), 'utf8');
      const player = JSON.parse(raw);
      if (isValidPlayer(player) && player[field] === value) {
        return normalizePlayer(player);
      }
    } catch {
      // Ignore malformed player files.
    }
  }

  return null;
}

async function updatePlayer(player) {
  const updated = {
    ...player,
    updatedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };

  if (hasPersistentConfig()) {
    await ensureSchema();
    await getPgPool().query(
      `
        UPDATE ${TABLE_NAME}
        SET display_name = $1,
          updated_at = $2,
          last_seen_at = $3,
          google_email = $4,
          google_name = $5,
          google_picture = $6
        WHERE id = $7
      `,
      [
        updated.displayName,
        updated.updatedAt,
        updated.lastSeenAt,
        updated.googleEmail,
        updated.googleName,
        updated.googlePicture,
        updated.id,
      ],
    );
    return updated;
  }

  await ensureDataDir();
  await fs.writeFile(getPlayerPath(updated.id), JSON.stringify(updated), 'utf8');
  return updated;
}

async function touchPlayer(id) {
  const player = await readPlayer(id);
  if (player === null) {
    return;
  }

  await updatePlayer(player);
}

async function mergeHighscores(id, primary, secondary) {
  if (!isValidPlayerId(id)) {
    return null;
  }

  const highscorePrimary = normalizeHighscore(primary);
  const highscoreSecondary = normalizeHighscore(secondary);

  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `
        UPDATE ${TABLE_NAME}
        SET highscore_primary = GREATEST(highscore_primary, $1),
          highscore_secondary = GREATEST(highscore_secondary, $2),
          updated_at = $3,
          last_seen_at = $3
        WHERE id = $4
        RETURNING id, provider, display_name, created_at, updated_at,
          last_seen_at, wallet_address, google_subject, google_email,
          google_name, google_picture, highscore_primary, highscore_secondary
      `,
      [highscorePrimary, highscoreSecondary, new Date().toISOString(), id],
    );

    return result.rowCount === 0 ? null : fromRow(result.rows[0]);
  }

  const player = await readPlayer(id);
  if (player === null) {
    return null;
  }

  return updatePlayer({
    ...player,
    highscorePrimary: Math.max(player.highscorePrimary, highscorePrimary),
    highscoreSecondary: Math.max(
      player.highscoreSecondary,
      highscoreSecondary,
    ),
  });
}

function toPublicPlayer(player) {
  return {
    id: player.id,
    provider: player.provider,
    displayName: player.displayName,
    walletAddress: player.walletAddress,
    googleEmail: player.googleEmail,
    googleName: player.googleName,
    googlePicture: player.googlePicture,
    highscorePrimary: normalizeHighscore(player.highscorePrimary),
    highscoreSecondary: normalizeHighscore(player.highscoreSecondary),
    createdAt: player.createdAt,
    lastSeenAt: player.lastSeenAt,
  };
}

function fromRow(row) {
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.display_name,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    walletAddress: row.wallet_address,
    googleSubject: row.google_subject,
    googleEmail: row.google_email,
    googleName: row.google_name,
    googlePicture: row.google_picture,
    highscorePrimary: normalizeHighscore(row.highscore_primary),
    highscoreSecondary: normalizeHighscore(row.highscore_secondary),
  };
}

function normalizePlayer(player) {
  return {
    ...player,
    highscorePrimary: normalizeHighscore(player.highscorePrimary),
    highscoreSecondary: normalizeHighscore(player.highscoreSecondary),
  };
}

function normalizeHighscore(value) {
  const score = Number(value);
  return Number.isFinite(score) && score >= 0 ? Math.floor(score) : 0;
}

function createPlayerId() {
  return `ply-${Date.now().toString(36)}-${crypto
    .randomBytes(10)
    .toString('hex')}`;
}

function shortenWallet(walletAddress) {
  return `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`;
}

function isValidPlayerId(value) {
  return typeof value === 'string' && /^ply-[a-z0-9-]+$/i.test(value);
}

function isValidPlayer(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    isValidPlayerId(value.id) &&
    (value.provider === 'wallet' || value.provider === 'google') &&
    typeof value.displayName === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.lastSeenAt === 'string'
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
  findOrCreateGooglePlayer,
  findOrCreateWalletPlayer,
  isPersistentStoreConfigured: hasPersistentConfig,
  mergeHighscores,
  readPlayer,
  toPublicPlayer,
};
