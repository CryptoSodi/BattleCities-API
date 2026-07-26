const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const storageConfig = require('../config/storageConfig');
const database = require('../database');

const TABLE_NAME = 'battlecity_wallet_challenges';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function getDataDir() {
  return (
    process.env.BATTLECITY_WALLET_CHALLENGE_DIR ||
    path.join(process.cwd(), 'server-data', 'wallet-challenges')
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

function getChallengePath(nonce) {
  return path.join(getDataDir(), `${nonce}.json`);
}

async function createChallenge(walletAddress) {
  if (!isValidWalletAddress(walletAddress)) {
    throw new Error('Invalid wallet address');
  }

  const challenge = {
    nonce: createNonce(),
    walletAddress,
    message: '',
    createdAt: new Date().toISOString(),
    usedAt: null,
  };
  challenge.message = createMessage(walletAddress, challenge.nonce);

  if (hasPersistentConfig()) {
    await ensureSchema();
    await getPgPool().query(
      `
        INSERT INTO ${TABLE_NAME}
          (nonce, wallet_address, message, created_at, used_at)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [
        challenge.nonce,
        challenge.walletAddress,
        challenge.message,
        challenge.createdAt,
        challenge.usedAt,
      ],
    );
    return toPublicChallenge(challenge);
  }

  await ensureDataDir();
  await fs.writeFile(
    getChallengePath(challenge.nonce),
    JSON.stringify(challenge),
    'utf8',
  );

  return toPublicChallenge(challenge);
}

async function verifyChallenge({ walletAddress, nonce, message, signature }) {
  if (
    !isValidWalletAddress(walletAddress) ||
    !isValidNonce(nonce) ||
    typeof message !== 'string' ||
    typeof signature !== 'string'
  ) {
    return false;
  }

  const challenge = await readChallenge(nonce);
  if (
    challenge === null ||
    challenge.usedAt !== null ||
    challenge.walletAddress !== walletAddress ||
    challenge.message !== message ||
    Date.now() - new Date(challenge.createdAt).getTime() > CHALLENGE_TTL_MS
  ) {
    return false;
  }

  if (!verifySignature(walletAddress, message, signature)) {
    return false;
  }

  await markChallengeUsed(nonce);
  return true;
}

async function readChallenge(nonce) {
  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `
        SELECT nonce, wallet_address, message, created_at, used_at
        FROM ${TABLE_NAME}
        WHERE nonce = $1
        LIMIT 1
      `,
      [nonce],
    );

    if (result.rowCount === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      nonce: row.nonce,
      walletAddress: row.wallet_address,
      message: row.message,
      createdAt: new Date(row.created_at).toISOString(),
      usedAt: row.used_at === null ? null : new Date(row.used_at).toISOString(),
    };
  }

  try {
    const raw = await fs.readFile(getChallengePath(nonce), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function markChallengeUsed(nonce) {
  const usedAt = new Date().toISOString();

  if (hasPersistentConfig()) {
    await getPgPool().query(
      `UPDATE ${TABLE_NAME} SET used_at = $1 WHERE nonce = $2`,
      [usedAt, nonce],
    );
    return;
  }

  const challenge = await readChallenge(nonce);
  if (challenge !== null) {
    challenge.usedAt = usedAt;
    await fs.writeFile(getChallengePath(nonce), JSON.stringify(challenge), 'utf8');
  }
}

function verifySignature(walletAddress, message, signatureBase64) {
  try {
    const publicKeyBytes = decodeBase58(walletAddress);
    const publicKey = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
      format: 'der',
      type: 'spki',
    });

    return crypto.verify(
      null,
      Buffer.from(message, 'utf8'),
      publicKey,
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    return false;
  }
}

function createMessage(walletAddress, nonce) {
  return [
    'Battle Cities wants you to sign in with your Solana wallet.',
    '',
    `Wallet: ${walletAddress}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join('\n');
}

function createNonce() {
  return crypto.randomBytes(16).toString('hex');
}

function toPublicChallenge(challenge) {
  return {
    nonce: challenge.nonce,
    message: challenge.message,
  };
}

function isValidNonce(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value);
}

function isValidWalletAddress(value) {
  return (
    typeof value === 'string' &&
    value.length >= 32 &&
    value.length <= 64 &&
    /^[1-9A-HJ-NP-Za-km-z]+$/.test(value)
  );
}

function decodeBase58(value) {
  const bytes = [0];

  for (let i = 0; i < value.length; i += 1) {
    const alphabetIndex = BASE58_ALPHABET.indexOf(value[i]);
    if (alphabetIndex === -1) {
      throw new Error('Invalid base58');
    }

    for (let j = 0; j < bytes.length; j += 1) {
      bytes[j] *= 58;
    }
    bytes[0] += alphabetIndex;

    let carry = 0;
    for (let j = 0; j < bytes.length; j += 1) {
      bytes[j] += carry;
      carry = bytes[j] >> 8;
      bytes[j] &= 0xff;
    }

    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  for (let i = 0; i < value.length && value[i] === '1'; i += 1) {
    bytes.push(0);
  }

  return Buffer.from(bytes.reverse());
}

module.exports = {
  createChallenge,
  isValidWalletAddress,
  verifyChallenge,
};
