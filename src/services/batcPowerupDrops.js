const crypto = require('crypto');
const fs = require('fs').promises;
const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;
const { Connection, Keypair, PublicKey, Transaction } = require('@solana/web3.js');
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} = require('@solana/spl-token');
const storageConfig = require('../config/storageConfig');
const dropStore = require('../stores/batcPowerupDropStore');

const MAINNET_BATC_MINT = 'Hxs5gXuPHv3Jhm7PYQv9iFMQp5ZYL2Fk6bgWdvQz15bz';
const CONFIRMED_STATUSES = new Set(['confirmed', 'finalized']);
let cachedKeypair = null;
let cachedKeypairPath = null;

async function roll(player, requestId, levelNumber) {
  const config = readConfig();
  if (!config.enabled || !storageConfig.hasDatabaseConfig()) return null;
  if (player?.provider !== 'wallet' || !player.walletAddress) return null;
  assertConfigured(config);
  if (!isSafeRequestId(requestId)) throw new Error('Invalid drop request id.');

  const rollValue = crypto.randomInt(10000);
  let amount = 0;
  if (rollValue < config.chance200Bps) amount = 200;
  else if (rollValue < config.chance200Bps + config.chance100Bps) amount = 100;

  return dropStore.issueRoll({
    id: `drop-${crypto.randomUUID()}`,
    requestId,
    playerId: player.id,
    walletAddress: player.walletAddress,
    levelNumber: normalizeLevel(levelNumber),
    amount,
    expiresAt: new Date(Date.now() + config.claimTtlMinutes * 60 * 1000).toISOString(),
    maxRollsPerDay: config.maxRollsPerDay,
    maxPlayerBatcPerDay: config.maxPlayerBatcPerDay,
    maxGlobalBatcPerDay: config.maxGlobalBatcPerDay,
  });
}

async function claim(player, claimId) {
  const config = readConfig();
  assertConfigured(config);
  const reward = await dropStore.findById(claimId);
  if (!reward || reward.playerId !== player?.id || reward.walletAddress !== player?.walletAddress) {
    throw new Error('BATC drop claim was not found.');
  }
  if (reward.amount !== 100 && reward.amount !== 200) {
    throw new Error('This drop has no BATC reward.');
  }
  if (
    reward.status !== 'delivered' &&
    reward.claimedAt === null &&
    Date.parse(reward.expiresAt) <= Date.now()
  ) {
    throw new Error('BATC drop claim expired.');
  }
  if (reward.status === 'delivered') return reward;

  const connection = new Connection(config.rpcUrl, 'confirmed');
  let current = reward;
  if (current.deliverySignature && current.deliveryRawTransaction) {
    const existing = await resolveExistingDelivery(connection, current);
    if (existing === 'delivered') {
      return dropStore.markDelivered(current.id, current.deliverySignature);
    }
    if (existing === 'retry') return broadcastPrepared(connection, current);
    const prepared = await createPreparedDelivery(connection, current, config);
    current = await dropStore.replaceDelivery(
      current.id,
      current.deliverySignature,
      prepared,
    );
    return broadcastPrepared(connection, current);
  }

  const prepared = await createPreparedDelivery(connection, current, config);
  current = await dropStore.prepareDelivery(current.id, prepared);
  return broadcastPrepared(connection, current);
}

async function resolveExistingDelivery(connection, reward) {
  const response = await connection.getSignatureStatuses(
    [reward.deliverySignature],
    { searchTransactionHistory: true },
  );
  const status = response.value[0];
  if (status && !status.err && CONFIRMED_STATUSES.has(status.confirmationStatus)) {
    return 'delivered';
  }
  const height = await connection.getBlockHeight('confirmed');
  return !status?.err && height <= Number(reward.deliveryLastValidBlockHeight)
    ? 'retry'
    : 'replace';
}

async function createPreparedDelivery(connection, reward, config) {
  const distributor = await loadDistributionKeypair(config);
  const owner = new PublicKey(reward.walletAddress);
  const source = getAssociatedTokenAddressSync(
    config.tokenMint,
    distributor.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const destination = getAssociatedTokenAddressSync(
    config.tokenMint,
    owner,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const sourceAccount = await getAccount(
    connection,
    source,
    'confirmed',
    TOKEN_2022_PROGRAM_ID,
  );
  const amountAtomic = BigInt(reward.amount) * 1000000n;
  if (!sourceAccount.owner.equals(distributor.publicKey) ||
      !sourceAccount.mint.equals(config.tokenMint)) {
    throw new Error('BATC reward source account does not match the configured wallet and mint.');
  }
  if (sourceAccount.amount < amountAtomic) {
    throw new Error('BATC reward wallet has insufficient tokens.');
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({
    feePayer: distributor.publicKey,
    recentBlockhash: blockhash,
  });
  transaction.add(createAssociatedTokenAccountIdempotentInstruction(
    distributor.publicKey,
    destination,
    owner,
    config.tokenMint,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  ));
  transaction.add(createTransferCheckedInstruction(
    source,
    config.tokenMint,
    destination,
    distributor.publicKey,
    amountAtomic,
    6,
    [],
    TOKEN_2022_PROGRAM_ID,
  ));
  transaction.sign(distributor);
  return {
    signature: bs58.encode(transaction.signature),
    rawTransaction: transaction.serialize().toString('base64'),
    blockhash,
    lastValidBlockHeight,
  };
}

async function broadcastPrepared(connection, reward) {
  try {
    const signature = await connection.sendRawTransaction(
      Buffer.from(reward.deliveryRawTransaction, 'base64'),
      { maxRetries: 3, skipPreflight: false },
    );
    if (signature !== reward.deliverySignature) {
      throw new Error('RPC returned an unexpected BATC reward signature.');
    }
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash: reward.deliveryBlockhash,
      lastValidBlockHeight: Number(reward.deliveryLastValidBlockHeight),
    }, 'confirmed');
    if (confirmation.value.err) {
      throw new Error(`BATC reward transfer failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    return dropStore.markDelivered(reward.id, signature);
  } catch (error) {
    const status = await connection.getSignatureStatuses(
      [reward.deliverySignature],
      { searchTransactionHistory: true },
    );
    const value = status.value[0];
    if (value && !value.err && CONFIRMED_STATUSES.has(value.confirmationStatus)) {
      return dropStore.markDelivered(reward.id, reward.deliverySignature);
    }
    await dropStore.markFailed(
      reward.id,
      reward.deliverySignature,
      cleanError(error),
    );
    throw error;
  }
}

async function loadDistributionKeypair(config) {
  if (cachedKeypair && cachedKeypairPath === config.distributionKeypairPath) {
    return cachedKeypair;
  }
  const stat = await fs.stat(config.distributionKeypairPath);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('BATC reward keypair permissions must be 600 or stricter.');
  }
  const bytes = JSON.parse(await fs.readFile(config.distributionKeypairPath, 'utf8'));
  if (!Array.isArray(bytes) || bytes.length !== 64) {
    throw new Error('BATC reward keypair file is invalid.');
  }
  const keypair = Keypair.fromSecretKey(Uint8Array.from(bytes));
  if (!keypair.publicKey.equals(config.distributionAddress)) {
    throw new Error('BATC reward keypair does not match its configured address.');
  }
  cachedKeypair = keypair;
  cachedKeypairPath = config.distributionKeypairPath;
  return keypair;
}

function readConfig() {
  const mintText = String(process.env.BATTLECITY_DROP_REWARD_TOKEN_MINT || MAINNET_BATC_MINT).trim();
  const addressText = String(process.env.BATTLECITY_DROP_REWARD_DISTRIBUTION_ADDRESS || '').trim();
  return {
    enabled: process.env.BATTLECITY_DROP_REWARDS_ENABLED === '1',
    network: String(process.env.BATTLECITY_DROP_REWARD_NETWORK || 'mainnet-beta').trim(),
    tokenMint: safePublicKey(mintText),
    distributionAddress: safePublicKey(addressText),
    distributionKeypairPath: String(process.env.BATTLECITY_DROP_REWARD_KEYPAIR_PATH || '').trim(),
    rpcUrl: String(process.env.BATTLECITY_DROP_REWARD_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com').trim(),
    chance100Bps: boundedInteger(process.env.BATTLECITY_DROP_REWARD_100_BPS, 25, 0, 10000),
    chance200Bps: boundedInteger(process.env.BATTLECITY_DROP_REWARD_200_BPS, 5, 0, 10000),
    claimTtlMinutes: boundedInteger(process.env.BATTLECITY_DROP_REWARD_CLAIM_TTL_MINUTES, 30, 5, 1440),
    maxRollsPerDay: boundedInteger(process.env.BATTLECITY_DROP_REWARD_MAX_ROLLS_PER_DAY, 100, 1, 10000),
    maxPlayerBatcPerDay: boundedInteger(process.env.BATTLECITY_DROP_REWARD_MAX_PLAYER_BATC_PER_DAY, 400, 100, 1000000),
    maxGlobalBatcPerDay: boundedInteger(process.env.BATTLECITY_DROP_REWARD_MAX_GLOBAL_BATC_PER_DAY, 10000, 100, 100000000),
  };
}

function assertConfigured(config) {
  if (!config.enabled) throw new Error('BATC drops are disabled.');
  if (!storageConfig.hasDatabaseConfig()) throw new Error('BATC drops require PostgreSQL.');
  if (config.network !== 'mainnet-beta') {
    throw new Error('BATC wallet drops must use Solana mainnet-beta.');
  }
  if (!config.tokenMint || config.tokenMint.toBase58() !== MAINNET_BATC_MINT) {
    throw new Error('BATC drop mint must be the production Token-2022 mint.');
  }
  if (!config.distributionAddress || !config.distributionKeypairPath) {
    throw new Error('BATC reward distribution wallet is not configured.');
  }
  if (config.chance100Bps + config.chance200Bps > 10000) {
    throw new Error('BATC drop odds exceed 100%.');
  }
}

function safePublicKey(value) {
  try { return value ? new PublicKey(value) : null; } catch { return null; }
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function normalizeLevel(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 999 ? parsed : 1;
}

function isSafeRequestId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{16,100}$/.test(value);
}

function cleanError(error) {
  return String(error?.message || error || 'BATC reward transfer failed')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 1000);
}

module.exports = { claim, readConfig, roll };
