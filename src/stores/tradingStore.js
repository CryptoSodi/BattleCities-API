const fs = require('fs').promises;
const path = require('path');
const storageConfig = require('../config/storageConfig');
const database = require('../database');
const solanaRpc = require('../services/solanaRpc');

// Trading volume + boost status (Milestone 5). The token catalog maps listed
// tokens to traits (our tank language: Hull/Armor/Engine/Salvage); the native
// token boosts All Stats; unlisted verified tokens combine into Armor —
// exactly the plan's grouping rules. Every accepted swap is idempotent by
// transaction signature.
//
// VERIFICATION MODES:
//   'mock' — explicit dev only: trusts the submitted summary but still
//     enforces signature idempotency, catalog rules, and eligible-pair rules.
//   'rpc' (default) — fetches the confirmed transaction from Solana
//     (BATTLECITY_SOLANA_RPC_URL, mainnet by default) and derives BOTH the
//     swapped mint and the stable-side USD volume from on-chain balance
//     changes; the client-declared mints/amounts are ignored. Swaps happen on
//     approved programs configured in BATTLECITY_SWAP_PROGRAM_IDS.
// SOL is priced via BATTLECITY_SOL_PRICE_USD until a price oracle is wired.

const TABLE_NAME = 'battlecity_trading_volume';
const VOLUME_WINDOW_DAYS = 30;
const MAX_VOLUME_USD_PER_SWAP = 1000000;

// 1% per this much 30-day USD volume, capped per trait.
const BOOST_USD_PER_PERCENT = 100;
const BOOST_MAX_PERCENT = 30;

const STABLE_MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
};

// Native token mint. BACT launches on testnet first — set BATTLECITY_BACT_MINT
// to the real mint address once the token exists; the placeholder keeps dev
// working until then.
function getNativeMint() {
  return (
    process.env.BATTLECITY_BACT_MINT ||
    'BACT1111111111111111111111111111111111111111'
  );
}

// Listed tokens -> traits. Native BACT boosts everything.
const TOKEN_CATALOG = [
  { mint: getNativeMint(), symbol: 'BACT', name: 'BATTLE CITY TOKEN', group: 'native', trait: 'all', featured: true },
  { mint: STABLE_MINTS.SOL, symbol: 'SOL', name: 'SOLANA', group: 'stable', trait: null, featured: true },
  { mint: STABLE_MINTS.USDC, symbol: 'USDC', name: 'USD COIN', group: 'stable', trait: null, featured: false },
  { mint: STABLE_MINTS.USDT, symbol: 'USDT', name: 'TETHER', group: 'stable', trait: null, featured: false },
  { mint: 'HULL11111111111111111111111111111111111111', symbol: 'IRON', name: 'IRONWORKS', group: 'listed', trait: 'hull', featured: true },
  { mint: 'ARMR11111111111111111111111111111111111111', symbol: 'PLATE', name: 'PLATEGUARD', group: 'listed', trait: 'armor', featured: true },
  { mint: 'ENGN11111111111111111111111111111111111111', symbol: 'NITRO', name: 'NITROCELL', group: 'listed', trait: 'engine', featured: true },
  { mint: 'LUCK11111111111111111111111111111111111111', symbol: 'SCRAP', name: 'SCRAPFIND', group: 'listed', trait: 'salvage', featured: true },
];

const TRAITS = ['hull', 'armor', 'engine', 'salvage'];

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

function listTokens() {
  return TOKEN_CATALOG.map((token) => ({ ...token }));
}

function findToken(mint) {
  return TOKEN_CATALOG.find((token) => token.mint === mint) || null;
}

function isStable(mint) {
  const token = findToken(mint);
  return token !== null && token.group === 'stable';
}

// Classifies the non-stable side of a swap. Returns null when the mint can't
// earn boosts (it's a stable itself).
function classifyBoostMint(boostMint) {
  const token = findToken(boostMint);

  if (token === null) {
    // Unlisted verified Solana token: broad, lower-trust volume -> Armor.
    return { mint: boostMint, trait: 'armor', group: 'unlisted' };
  }
  if (token.group === 'native') {
    return { mint: boostMint, trait: 'all', group: 'native' };
  }
  if (token.group === 'listed') {
    return { mint: boostMint, trait: token.trait, group: 'listed' };
  }

  return null; // stable on the non-stable side: excluded
}

// Eligible pairs are Listed/Stable, Native/Stable, or Unlisted/Stable — the
// non-stable side decides the trait. Returns null when ineligible.
function resolveBoostTarget(fromMint, toMint) {
  const fromStable = isStable(fromMint);
  const toStable = isStable(toMint);
  if (fromStable === toStable) {
    return null; // stable/stable or token/token: no boost volume
  }

  return classifyBoostMint(fromStable ? toMint : fromMint);
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

    target = classifyBoostMint(facts.boostMint);
    if (target === null) {
      return { ok: false, error: 'Pair not eligible for boosts' };
    }
    volumeUsd = facts.volumeUsd;
    fromMint = 'onchain';
    toMint = facts.boostMint;
    if (!Number.isFinite(tx.blockTime) || tx.blockTime * 1000 > Date.now() + 60000) {
      return { ok: false, error: 'Transaction time is unavailable or invalid' };
    }
    executedAt = new Date(tx.blockTime * 1000).toISOString();
  } else {
    volumeUsd = Number(input?.volumeUsd);
    target = resolveBoostTarget(fromMint, toMint);
    if (target === null) {
      return { ok: false, error: 'Pair not eligible for boosts' };
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
    trait: target.trait,
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
        record.trait,
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

// 30-day per-trait boost percentages + volume rows for one player.
async function getBoostStatus(playerId) {
  const since = Date.now() - VOLUME_WINDOW_DAYS * 24 * 3600 * 1000;
  const records = await listPlayerRecordsSince(playerId, since);

  const volumeByTrait = { all: 0, hull: 0, armor: 0, engine: 0, salvage: 0 };
  const byMint = new Map();
  let totalVolume = 0;

  for (const record of records) {
    volumeByTrait[record.trait] += record.volumeUsd;
    totalVolume += record.volumeUsd;

    const token = findToken(record.mint);
    const key = record.mint;
    const row = byMint.get(key) || {
      mint: record.mint,
      symbol: token === null ? 'UNLISTED' : token.symbol,
      group: token === null ? 'unlisted' : token.group,
      trait: record.trait,
      volumeUsd: 0,
    };
    row.volumeUsd += record.volumeUsd;
    byMint.set(key, row);
  }

  const boosts = {};
  TRAITS.forEach((trait) => {
    const usd = volumeByTrait[trait] + volumeByTrait.all;
    boosts[trait] = Math.min(
      BOOST_MAX_PERCENT,
      Math.floor(usd / BOOST_USD_PER_PERCENT),
    );
  });

  return {
    windowDays: VOLUME_WINDOW_DAYS,
    totalVolumeUsd: Math.round(totalVolume * 100) / 100,
    boosts,
    rows: Array.from(byMint.values()).sort((a, b) => b.volumeUsd - a.volumeUsd),
  };
}

async function listPlayerRecordsSince(playerId, sinceMs) {
  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `
        SELECT signature, mint, trait, volume_usd, created_at
        FROM ${TABLE_NAME}
        WHERE player_id = $1 AND created_at >= $2
      `,
      [playerId, new Date(sinceMs).toISOString()],
    );
    return result.rows.map((row) => ({
      signature: row.signature,
      mint: row.mint,
      trait: row.trait,
      volumeUsd: Number(row.volume_usd),
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  let files;
  try {
    files = await fs.readdir(getDataDir());
  } catch {
    return [];
  }

  const records = [];
  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue;
    }
    try {
      const record = JSON.parse(
        await fs.readFile(path.join(getDataDir(), file), 'utf8'),
      );
      if (
        record.playerId === playerId &&
        Date.parse(record.createdAt) >= sinceMs
      ) {
        records.push(record);
      }
    } catch {
      // Ignore malformed records.
    }
  }

  return records;
}

// Only chain-verified swaps earn ranking or prize eligibility. Legacy/mock
// records remain available to development boost tools, never to prize boards.
async function getLeaderboard(startsAt = null, endsAt = null, limit = 20, playerId = null, prizeOnly = false) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(`WITH totals AS (
      SELECT v.player_id, MAX(p.wallet_address) AS wallet_address, MAX(p.display_name) AS display_name,
        SUM(v.volume_usd) AS total_points, COUNT(*)::integer AS matches
      FROM ${TABLE_NAME} v JOIN battlecity_players p ON p.id = v.player_id
      WHERE v.verified = TRUE AND p.provider <> 'guest'
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
      if (!player || player.provider === 'guest') continue;
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
  getBoostStatus,
  getVerifyMode,
  listTokens,
  recordSwap,
  resolveBoostTarget,
  isPersistentStoreConfigured: hasPersistentConfig,
};
