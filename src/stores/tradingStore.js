const fs = require('fs').promises;
const path = require('path');
const storageConfig = require('../config/storageConfig');
const database = require('../database');
const solanaRpc = require('../services/solanaRpc');

// Chain-verified swap volume for trading rankings. Swaps never grant combat
// perks. Every accepted swap is idempotent by transaction signature.
const TABLE_NAME = 'battlecity_trading_volume';
const MAX_VOLUME_USD_PER_SWAP = 1000000;

const STABLE_MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
};

function listTokens() {
  const items = Object.entries(STABLE_MINTS).map(([symbol, mint]) => ({
    mint, symbol, name: symbol, group: 'stable', featured: symbol === 'SOL',
  }));
  const skr = require('../services/skrToken').config();
  if (skr) items.push({ mint: skr.mint, symbol: 'SKR', name: 'SKR', group: 'token', featured: true });
  const mint = String(process.env.BATTLECITY_SHOP_TOKEN_MINT || require('../services/shopPaymentService').TOKEN_MINT).trim();
  if (mint) items.push({ mint, symbol: 'BATC', name: 'Battle Cities', group: 'token', featured: true });
  return items;
}

function getDataDir() {
  return (
    process.env.BATTLECITY_TRADING_DIR ||
    path.join(process.cwd(), 'server-data', 'trading')
  );
}

function getVerifyMode() {
  const mode = String(process.env.BATTLECITY_SWAP_VERIFY_MODE || 'rpc')
    .trim()
    .toLowerCase();
  return mode === 'mock' && !storageConfig.isProductionRuntime() ? 'mock' : 'rpc';
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

function isStable(mint) {
  return Object.values(STABLE_MINTS).includes(mint);
}

function classifyToken(mint) {
  return typeof mint === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(mint) && !isStable(mint) ? { mint } : null;
}

function resolveToken(fromMint, toMint) {
  if (isStable(fromMint) === isStable(toMint)) return null;
  return classifyToken(isStable(fromMint) ? toMint : fromMint);
}

function getSolPriceUsd() {
  const parsed = Number(process.env.BATTLECITY_SOL_PRICE_USD);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function hasApprovedSwapProgram(tx) {
  const programs = new Set(String(process.env.BATTLECITY_SWAP_PROGRAM_IDS || 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')
    .split(',').map((p) => p.trim()).filter(Boolean));
  const keys = tx.transaction?.message?.accountKeys || [];
  const instructions = [...(tx.transaction?.message?.instructions || []),
    ...(tx.meta?.innerInstructions || []).flatMap((item) => item.instructions || [])];
  return instructions.some((i) => {
    const key = keys[i.programIdIndex];
    return programs.has(i.programId || (typeof key === 'string' ? key : key?.pubkey));
  });
}

// Verifies and records one swap. Idempotent by signature: replays return
// { ok: false, error: 'Already recorded' } and change nothing.
async function recordSwap(player, input) {
  if (!player || player.provider !== 'wallet') return { ok: false, error: 'Wallet login required' };
  const signature = typeof input?.signature === 'string' ? input.signature.trim() : '';
  if (!/^[1-9A-HJ-NP-Za-km-z]{20,128}$/.test(signature)) {
    return { ok: false, error: 'Invalid signature' };
  }

  let target;
  let volumeUsd;
  let fromMint = String(input?.fromMint || '');
  let toMint = String(input?.toMint || '');
  let executedAt = new Date().toISOString();
  const verified = getVerifyMode() === 'rpc';

  if (getVerifyMode() === 'rpc') {
    // Trustless path: everything is derived from the confirmed on-chain
    // transaction; the client-declared mints/amounts are ignored.
    if (typeof player.walletAddress !== 'string' || player.walletAddress === '') {
      return { ok: false, error: 'Wallet login required' };
    }

    let tx;
    try {
      tx = await solanaRpc.getTransaction(signature);
    } catch {
      return { ok: false, error: 'RPC unavailable, try again' };
    }
    if (tx === null) {
      return { ok: false, error: 'Transaction not found or not confirmed' };
    }
    if (!hasApprovedSwapProgram(tx)) return { ok: false, error: 'No approved swap program was executed' };

    const facts = solanaRpc.deriveSwapFromTransaction(tx, player.walletAddress, {
      stableMints: Object.values(STABLE_MINTS),
      solPriceUsd: getSolPriceUsd(),
    });
    if (!facts.ok) {
      return { ok: false, error: facts.error };
    }

    target = classifyToken(facts.tokenMint);
    if (target === null) {
      return { ok: false, error: 'Pair not eligible for trading volume' };
    }
    volumeUsd = facts.volumeUsd;
    fromMint = 'onchain';
    toMint = facts.tokenMint;
    if (!Number.isFinite(tx.blockTime) || tx.blockTime * 1000 > Date.now() + 60000) {
      return { ok: false, error: 'Transaction time is unavailable or invalid' };
    }
    executedAt = new Date(tx.blockTime * 1000).toISOString();
  } else {
    volumeUsd = Number(input?.volumeUsd);
    target = resolveToken(fromMint, toMint);
    if (target === null) {
      return { ok: false, error: 'Pair not eligible for trading volume' };
    }
  }

  if (!Number.isFinite(volumeUsd) || volumeUsd <= 0 || volumeUsd > MAX_VOLUME_USD_PER_SWAP) {
    return { ok: false, error: 'Invalid volume' };
  }

  const record = {
    signature,
    playerId: player.id,
    walletAddress: player.walletAddress || null,
    mint: target.mint,
    volumeUsd: Math.round(volumeUsd * 100) / 100,
    swapFromMint: fromMint,
    swapToMint: toMint,
    createdAt: executedAt,
    verified,
    prizeEligible: verified && await require('./swapExecutionStore').isVerified(player.id, signature),
  };

  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `
        INSERT INTO ${TABLE_NAME}
          (
            signature, player_id, wallet_address, mint, trait, volume_usd,
            swap_from_mint, swap_to_mint, created_at, verified, prize_eligible
          )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (signature) DO NOTHING
      `,
      [
        record.signature,
        record.playerId,
        record.walletAddress,
        record.mint,
        'armor', // Retained historical NOT NULL column; no gameplay boost is computed.
        record.volumeUsd,
        record.swapFromMint,
        record.swapToMint,
        record.createdAt,
        record.verified,
        record.prizeEligible,
      ],
    );

    if (result.rowCount === 0) {
      return { ok: false, error: 'Already recorded' };
    }
    return { ok: true, record };
  }

  await fs.mkdir(getDataDir(), { recursive: true });
  const filePath = path.join(getDataDir(), `${signature}.json`);
  try {
    await fs.writeFile(filePath, JSON.stringify(record), { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      return { ok: false, error: 'Already recorded' };
    }
    throw error;
  }

  return { ok: true, record };
}

// Only chain-verified swaps earn ranking or prize eligibility.
async function getLeaderboard(startsAt = null, endsAt = null, limit = 20, playerId = null, prizeOnly = false) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(`WITH totals AS (
      SELECT v.player_id, MAX(p.wallet_address) AS wallet_address, MAX(p.display_name) AS display_name,
        SUM(v.volume_usd) AS total_points, COUNT(*)::integer AS matches
      FROM ${TABLE_NAME} v JOIN battlecity_players p ON p.id = v.player_id
      WHERE v.verified = TRUE AND p.provider = 'wallet'
        AND (NOT $5::boolean OR v.prize_eligible = TRUE)
        AND ($1::timestamptz IS NULL OR v.created_at >= $1)
        AND ($2::timestamptz IS NULL OR v.created_at < $2)
      GROUP BY v.player_id), ranked AS (
        SELECT *, ROW_NUMBER() OVER (ORDER BY total_points DESC, player_id ASC) AS rank FROM totals)
      SELECT * FROM ranked WHERE rank <= $3 OR player_id = $4 ORDER BY rank`,
    [startsAt, endsAt, safeLimit, playerId, prizeOnly]);
    return result.rows.map((r) => ({ playerId: r.player_id, walletAddress: r.wallet_address,
      displayName: r.display_name, totalPoints: Number(r.total_points), volumeUsd: Number(r.total_points),
      matches: Number(r.matches), rank: Number(r.rank), perks: [] }));
  }
  const players = require('./playerStore');
  const totals = new Map();
  let files;
  try { files = await fs.readdir(getDataDir()); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const r = JSON.parse(await fs.readFile(path.join(getDataDir(), file), 'utf8'));
    const at = Date.parse(r.createdAt);
    if (prizeOnly && !r.prizeEligible) continue;
    if (!r.verified || !Number.isFinite(at) || (startsAt && at < Date.parse(startsAt))
      || (endsAt && at >= Date.parse(endsAt)) || !Number.isFinite(r.volumeUsd) || r.volumeUsd <= 0) continue;
    let row = totals.get(r.playerId);
    if (!row) {
      const player = await players.readPlayer(r.playerId);
      if (!player || player.provider !== 'wallet') continue;
      row = { playerId: r.playerId, displayName: player.displayName, walletAddress: player.walletAddress,
        totalPoints: 0, matches: 0, perks: [] };
      totals.set(r.playerId, row);
    }
    row.totalPoints += r.volumeUsd; row.matches++;
  }
  return Array.from(totals.values()).sort((a, b) => b.totalPoints - a.totalPoints || a.playerId.localeCompare(b.playerId))
    .map((r, i) => ({ ...r, totalPoints: Math.round(r.totalPoints * 100) / 100, volumeUsd: Math.round(r.totalPoints * 100) / 100, rank: i + 1 }))
    .filter((r) => r.rank <= safeLimit || r.playerId === playerId);
}

module.exports = {
  getLeaderboard,
  getVerifyMode,
  listTokens,
  recordSwap,
  isPersistentStoreConfigured: hasPersistentConfig,
};
