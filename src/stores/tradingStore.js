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
//   'mock' (default) — dev only: trusts the submitted summary but still
//     enforces signature idempotency, catalog rules, and eligible-pair rules.
//   'rpc' — trustless: fetches the confirmed transaction from Solana
//     (BATTLECITY_SOLANA_RPC_URL, testnet by default) and derives BOTH the
//     swapped mint and the stable-side USD volume from on-chain balance
//     changes; the client-declared mints/amounts are ignored. Swaps happen on
//     Raydium, but verification is venue-agnostic. Set
//     BATTLECITY_SWAP_VERIFY_MODE=rpc once the BACT testnet token exists.
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
  const mode = String(process.env.BATTLECITY_SWAP_VERIFY_MODE || 'mock')
    .trim()
    .toLowerCase();
  return mode === 'rpc' ? 'rpc' : 'mock';
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
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 150;
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
    createdAt: new Date().toISOString(),
  };

  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `
        INSERT INTO ${TABLE_NAME}
          (
            signature, player_id, wallet_address, mint, trait, volume_usd,
            swap_from_mint, swap_to_mint, created_at
          )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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

module.exports = {
  getBoostStatus,
  getVerifyMode,
  listTokens,
  recordSwap,
  resolveBoostTarget,
  isPersistentStoreConfigured: hasPersistentConfig,
};
