const fs = require('fs').promises;
const path = require('path');
const storageConfig = require('../config/storageConfig');
const database = require('../database');
const ledgerStore = require('./ledgerStore');

const TABLE_NAME = 'battlecity_economy_accounts';
const MAX_GUEST_INVENTORY_COUNT = 99;
const SHOP_STARTING_TOKEN_BALANCE = 1000;
const SHOP_STARTING_SOL_BALANCE = 1.25;
const SHOP_GUEST_FUEL_BALANCE = 9999;
const SHOP_CATALOG = {
  'fuel-one': { price: 10, solPrice: 0.01, fuel: 1 },
  'fuel-five': { price: 45, solPrice: 0.04, fuel: 5 },
  'fuel-twenty': { price: 160, solPrice: 0.12, fuel: 20 },
  shield: { price: 25, solPrice: 0.02, inventory: { shield: 1 } },
  'base-defence': { price: 30, solPrice: 0.025, inventory: { 'base-defence': 1 } },
  freeze: { price: 35, solPrice: 0.03, inventory: { freeze: 1 } },
  speed: { price: 35, solPrice: 0.03, inventory: { speed: 1 } },
  upgrade: { price: 50, solPrice: 0.045, inventory: { upgrade: 1 } },
  'zoom-out': { price: 30, solPrice: 0.025, inventory: { 'zoom-out': 1 } },
  wipeout: { price: 45, solPrice: 0.04, inventory: { wipeout: 1 } },
  'extra-life': { price: 40, solPrice: 0.035, inventory: { 'extra-life': 1 } },
  'starter-pack': {
    price: 90,
    solPrice: 0.08,
    fuel: 5,
    inventory: { shield: 1, 'base-defence': 1 },
  },
};
const INVENTORY_KEYS = [
  'shield',
  'base-defence',
  'freeze',
  'speed',
  'upgrade',
  'zoom-out',
  'wipeout',
  'extra-life',
];

function getDataDir() {
  return (
    process.env.BATTLECITY_ECONOMY_DIR ||
    path.join(process.cwd(), 'server-data', 'economy')
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

function getAccountPath(playerId) {
  return path.join(getDataDir(), `${playerId}.json`);
}

async function readAccount(playerId) {
  if (!isValidPlayerId(playerId)) {
    return null;
  }

  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `
        SELECT player_id, provider, wallet_address, token_balance,
          sol_balance, fuel_balance, inventory_json, loadout_json,
          created_at, updated_at
        FROM ${TABLE_NAME}
        WHERE player_id = $1
        LIMIT 1
      `,
      [playerId],
    );

    if (result.rowCount === 0) {
      return null;
    }

    return normalizeAccount(fromRow(result.rows[0]));
  }

  try {
    const raw = await fs.readFile(getAccountPath(playerId), 'utf8');
    return normalizeAccount(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function ensureAccountForPlayer(player) {
  if (!isValidPlayer(player)) {
    throw new Error('Invalid player');
  }

  const existing = await readAccount(player.id);
  if (existing !== null) {
    const updated = {
      ...existing,
      provider: player.provider,
      walletAddress: player.walletAddress || existing.walletAddress || null,
      updatedAt: new Date().toISOString(),
    };
    await writeAccount(updated);
    return updated;
  }

  const now = new Date().toISOString();
  const isGuest = player.provider === 'guest';
  const account = normalizeAccount({
    playerId: player.id,
    provider: player.provider,
    walletAddress: player.walletAddress || null,
    tokenBalance: SHOP_STARTING_TOKEN_BALANCE,
    solBalance: SHOP_STARTING_SOL_BALANCE,
    fuelBalance: isGuest ? SHOP_GUEST_FUEL_BALANCE : 0,
    inventory: isGuest ? createGuestInventory() : {},
    loadout: {},
    createdAt: now,
    updatedAt: now,
  });

  await writeAccount(account);
  return account;
}

async function upsertAccountForPlayer(player, snapshot) {
  if (!isValidPlayer(player)) {
    throw new Error('Invalid player');
  }

  const existing = await ensureAccountForPlayer(player);
  const nextSnapshot = typeof snapshot === 'object' && snapshot !== null ? snapshot : {};
  const normalized = normalizeSyncedAccount(existing, nextSnapshot, player);

  await writeAccount(normalized);
  return normalized;
}

async function purchaseItemForPlayer(player, itemId, currency) {
  if (!isValidPlayer(player)) {
    throw new Error('Invalid player');
  }

  const item = SHOP_CATALOG[itemId];
  if (item === undefined) {
    return { ok: false, statusText: 'ITEM NOT FOUND' };
  }

  const account = await ensureAccountForPlayer(player);
  const paymentCurrency = currency === 'sol' ? 'sol' : 'token';

  if (paymentCurrency === 'sol') {
    if (account.solBalance < item.solPrice) {
      return { ok: false, statusText: 'NEED MORE SOL' };
    }

    account.solBalance = Number((account.solBalance - item.solPrice).toFixed(4));
  } else if (account.tokenBalance < item.price) {
    return { ok: false, statusText: 'NEED MORE BACT' };
  } else {
    account.tokenBalance -= item.price;
  }

  if (typeof item.fuel === 'number' && item.fuel > 0) {
    account.fuelBalance += item.fuel;
  }

  if (item.inventory !== undefined) {
    Object.keys(item.inventory).forEach((key) => {
      account.inventory[key] = (account.inventory[key] || 0) + item.inventory[key];
    });
  }

  account.updatedAt = new Date().toISOString();
  await writeAccount(account);

  const txHash = createMockTransactionHash();
  await appendPurchaseLedgerEntries(account, item, itemId, paymentCurrency, txHash);

  return {
    ok: true,
    statusText: `BOUGHT ${itemId.toUpperCase()}`,
    txHash,
    account: toPublicAccount(account),
  };
}

// Every purchase is auditable: one debit entry for the price paid, plus one
// credit entry per reward (fuel and each inventory item). sourceId ties the
// debit and its credits together via the transaction hash.
async function appendPurchaseLedgerEntries(
  account,
  item,
  itemId,
  paymentCurrency,
  txHash,
) {
  const base = {
    playerId: account.playerId,
    walletAddress: account.walletAddress,
    reason: 'shop-purchase',
    sourceType: 'shop-item',
    sourceId: `${itemId}:${txHash}`,
  };

  const entries = [
    {
      ...base,
      currency: paymentCurrency === 'sol' ? 'sol' : 'token',
      amount: paymentCurrency === 'sol' ? -item.solPrice : -item.price,
    },
  ];

  if (typeof item.fuel === 'number' && item.fuel > 0) {
    entries.push({ ...base, currency: 'fuel', amount: item.fuel });
  }

  if (item.inventory !== undefined) {
    Object.keys(item.inventory).forEach((key) => {
      entries.push({
        ...base,
        currency: `item:${key}`,
        amount: item.inventory[key],
      });
    });
  }

  await ledgerStore.appendEntries(entries);
}

// Debits tokens from a player's account (e.g. locking a stake). Returns the
// updated account, or null when the balance is insufficient. The CALLER is
// responsible for the matching ledger entries.
async function debitTokens(player, amount) {
  if (!isValidPlayer(player)) {
    throw new Error('Invalid player');
  }

  const safeAmount = Math.floor(Number(amount));
  if (!Number.isFinite(safeAmount) || safeAmount <= 0) {
    return null;
  }

  const account = await ensureAccountForPlayer(player);
  if (account.tokenBalance < safeAmount) {
    return null;
  }

  account.tokenBalance -= safeAmount;
  account.updatedAt = new Date().toISOString();
  await writeAccount(account);

  return account;
}

// Fuel used to enter multiplayer matches must be changed by the API, not by
// a client account snapshot. Callers wrap this in the same transaction as the
// room assignment so a charge can never exist without its match membership.
async function debitFuel(player, amount, context = {}) {
  if (!isValidPlayer(player)) {
    throw new Error('Invalid player');
  }

  const safeAmount = Math.floor(Number(amount));
  if (!Number.isFinite(safeAmount) || safeAmount <= 0) {
    return null;
  }

  return database.withTransaction(async () => {
    let account;
    if (hasPersistentConfig()) {
      account = await lockAccountForFuelMutation(player);
      if (player.provider !== 'guest') {
        const updated = await getPgPool().query(
          `
            UPDATE ${TABLE_NAME}
            SET fuel_balance = fuel_balance - $2, updated_at = $3
            WHERE player_id = $1 AND fuel_balance >= $2
            RETURNING player_id, provider, wallet_address, token_balance,
              sol_balance, fuel_balance, inventory_json, loadout_json,
              created_at, updated_at
          `,
          [player.id, safeAmount, new Date().toISOString()],
        );
        if (updated.rowCount === 0) {
          return null;
        }
        account = normalizeAccount(fromRow(updated.rows[0]));
      }
    } else {
      account = await ensureAccountForPlayer(player);
      if (player.provider !== 'guest') {
        if (account.fuelBalance < safeAmount) {
          return null;
        }
        account.fuelBalance -= safeAmount;
        account.updatedAt = new Date().toISOString();
        await writeAccount(account);
      }
    }

    if (player.provider !== 'guest') {
      await ledgerStore.appendEntries({
        playerId: player.id,
        walletAddress: player.walletAddress || null,
        currency: 'fuel',
        amount: -safeAmount,
        reason: context.reason || 'multiplayer-entry',
        sourceType: context.sourceType || 'multiplayer-match',
        sourceId: context.sourceId || null,
        eventId: context.eventId || null,
      });
    }
    return account;
  });
}

async function creditFuel(player, amount, context = {}) {
  if (!isValidPlayer(player)) {
    throw new Error('Invalid player');
  }

  const safeAmount = Math.floor(Number(amount));
  if (!Number.isFinite(safeAmount) || safeAmount <= 0) {
    return ensureAccountForPlayer(player);
  }

  return database.withTransaction(async () => {
    let account;
    if (hasPersistentConfig()) {
      account = await lockAccountForFuelMutation(player);
      if (player.provider !== 'guest') {
        const updated = await getPgPool().query(
          `
            UPDATE ${TABLE_NAME}
            SET fuel_balance = fuel_balance + $2, updated_at = $3
            WHERE player_id = $1
            RETURNING player_id, provider, wallet_address, token_balance,
              sol_balance, fuel_balance, inventory_json, loadout_json,
              created_at, updated_at
          `,
          [player.id, safeAmount, new Date().toISOString()],
        );
        account = normalizeAccount(fromRow(updated.rows[0]));
      }
    } else {
      account = await ensureAccountForPlayer(player);
      if (player.provider !== 'guest') {
        account.fuelBalance += safeAmount;
        account.updatedAt = new Date().toISOString();
        await writeAccount(account);
      }
    }

    if (player.provider !== 'guest') {
      await ledgerStore.appendEntries({
        playerId: player.id,
        walletAddress: player.walletAddress || null,
        currency: 'fuel',
        amount: safeAmount,
        reason: context.reason || 'multiplayer-refund',
        sourceType: context.sourceType || 'multiplayer-match',
        sourceId: context.sourceId || null,
        eventId: context.eventId || null,
      });
    }
    return account;
  });
}

async function lockAccountForFuelMutation(player) {
  await ensureSchema();
  let result = await getPgPool().query(
    `
      SELECT player_id, provider, wallet_address, token_balance,
        sol_balance, fuel_balance, inventory_json, loadout_json,
        created_at, updated_at
      FROM ${TABLE_NAME}
      WHERE player_id = $1
      FOR UPDATE
    `,
    [player.id],
  );
  if (result.rowCount === 0) {
    await ensureAccountForPlayer(player);
    result = await getPgPool().query(
      `
        SELECT player_id, provider, wallet_address, token_balance,
          sol_balance, fuel_balance, inventory_json, loadout_json,
          created_at, updated_at
        FROM ${TABLE_NAME}
        WHERE player_id = $1
        FOR UPDATE
      `,
      [player.id],
    );
  }
  return normalizeAccount(fromRow(result.rows[0]));
}

// Credits soft rewards (fuel/token) to a player's account — used by quest
// claims and other reward flows. The CALLER is responsible for the matching
// ledger entries (it knows the reason/source context).
async function creditRewards(player, rewards) {
  if (!isValidPlayer(player)) {
    throw new Error('Invalid player');
  }

  const fuel = Math.max(0, Math.floor(Number(rewards?.fuel) || 0));
  const token = Math.max(0, Math.floor(Number(rewards?.token) || 0));
  if (fuel === 0 && token === 0) {
    return readAccount(player.id);
  }

  const account = await ensureAccountForPlayer(player);
  account.fuelBalance += fuel;
  account.tokenBalance += token;
  account.updatedAt = new Date().toISOString();
  await writeAccount(account);

  return account;
}

async function writeAccount(account) {
  const normalized = normalizeAccount(account);

  if (hasPersistentConfig()) {
    await ensureSchema();
    await getPgPool().query(
      `
        INSERT INTO ${TABLE_NAME}
          (
            player_id,
            provider,
            wallet_address,
            token_balance,
            sol_balance,
            fuel_balance,
            inventory_json,
            loadout_json,
            created_at,
            updated_at
          )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
        ON CONFLICT (player_id) DO UPDATE SET
          provider = EXCLUDED.provider,
          wallet_address = EXCLUDED.wallet_address,
          token_balance = EXCLUDED.token_balance,
          sol_balance = EXCLUDED.sol_balance,
          fuel_balance = EXCLUDED.fuel_balance,
          inventory_json = EXCLUDED.inventory_json,
          loadout_json = EXCLUDED.loadout_json,
          updated_at = EXCLUDED.updated_at
      `,
      [
        normalized.playerId,
        normalized.provider,
        normalized.walletAddress,
        normalized.tokenBalance,
        normalized.solBalance,
        normalized.fuelBalance,
        JSON.stringify(normalized.inventory),
        JSON.stringify(normalized.loadout),
        normalized.createdAt,
        normalized.updatedAt,
      ],
    );
    return;
  }

  await ensureDataDir();
  await fs.writeFile(
    getAccountPath(normalized.playerId),
    JSON.stringify(normalized),
    'utf8',
  );
}

function toPublicAccount(account) {
  const normalized = normalizeAccount(account);
  return {
    playerId: normalized.playerId,
    provider: normalized.provider,
    walletAddress: normalized.walletAddress,
    tokenBalance: normalized.tokenBalance,
    solBalance: normalized.solBalance,
    fuelBalance: normalized.fuelBalance,
    inventory: normalized.inventory,
    loadout: normalized.loadout,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
  };
}

function fromRow(row) {
  return {
    playerId: row.player_id,
    provider: row.provider,
    walletAddress: row.wallet_address,
    tokenBalance: Number(row.token_balance || 0),
    solBalance: Number(row.sol_balance || 0),
    fuelBalance: Number(row.fuel_balance || 0),
    inventory: parseJson(row.inventory_json, {}),
    loadout: parseJson(row.loadout_json, {}),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function normalizeAccount(value) {
  const now = new Date().toISOString();
  const account = typeof value === 'object' && value !== null ? value : {};

  return {
    playerId: isValidPlayerId(account.playerId) ? account.playerId : '',
    provider:
      account.provider === 'guest' ||
      account.provider === 'wallet' ||
      account.provider === 'google'
        ? account.provider
        : 'guest',
    walletAddress: typeof account.walletAddress === 'string' ? account.walletAddress : null,
    tokenBalance: normalizeNumber(account.tokenBalance, SHOP_STARTING_TOKEN_BALANCE),
    solBalance: normalizeNumber(account.solBalance, SHOP_STARTING_SOL_BALANCE),
    fuelBalance: normalizeInteger(
      account.fuelBalance,
      account.provider === 'guest' ? SHOP_GUEST_FUEL_BALANCE : 0,
    ),
    inventory: normalizeObject(account.inventory),
    loadout: normalizeObject(account.loadout),
    createdAt: typeof account.createdAt === 'string' ? account.createdAt : now,
    updatedAt: typeof account.updatedAt === 'string' ? account.updatedAt : now,
  };
}

function normalizeSyncedAccount(existing, snapshot, player) {
  const nextInventory = normalizeSyncedInventory(existing.inventory, snapshot.inventory);
  const nextLoadout = normalizeSyncedLoadout(nextInventory, snapshot.loadout);

  return normalizeAccount({
    ...existing,
    playerId: existing.playerId,
    provider: player.provider,
    walletAddress: player.walletAddress || existing.walletAddress || null,
    tokenBalance: existing.tokenBalance,
    solBalance: existing.solBalance,
    fuelBalance: normalizeNonIncreasingInteger(
      snapshot.fuelBalance,
      existing.fuelBalance,
      existing.fuelBalance,
    ),
    inventory: nextInventory,
    loadout: nextLoadout,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  });
}

function normalizeSyncedInventory(existingInventory, snapshotInventory) {
  const existing = normalizeObject(existingInventory);
  const snapshot = normalizeObject(snapshotInventory);
  const nextInventory = { ...existing };

  Object.keys(snapshot).forEach((key) => {
    if (!isValidInventoryKey(key)) {
      throw new Error('Invalid inventory item');
    }

    const nextCount = normalizeNonNegativeInteger(
      snapshot[key],
      existing[key] || 0,
    );
    const existingCount = normalizeNonNegativeInteger(
      existing[key],
      0,
    );

    if (nextCount > existingCount) {
      throw new Error('Inventory increases must use purchase endpoint');
    }

    nextInventory[key] = nextCount;
  });

  INVENTORY_KEYS.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(nextInventory, key)) {
      nextInventory[key] = normalizeNonNegativeInteger(existing[key], 0);
    }
  });

  return nextInventory;
}

function normalizeSyncedLoadout(inventory, snapshotLoadout) {
  const snapshot = normalizeObject(snapshotLoadout);
  const nextLoadout = {};
  const seen = new Set();

  Object.keys(snapshot).forEach((key) => {
    if (!isValidLoadoutSlot(key)) {
      throw new Error('Invalid loadout slot');
    }

    const itemId = snapshot[key];
    if (itemId === undefined || itemId === null) {
      return;
    }

    if (!isValidInventoryKey(itemId)) {
      throw new Error('Invalid loadout item');
    }

    if ((inventory[itemId] || 0) <= 0) {
      throw new Error('Loadout item must be owned');
    }

    if (seen.has(itemId)) {
      throw new Error('Duplicate loadout item');
    }

    seen.add(itemId);
    nextLoadout[key] = itemId;
  });

  if (
    nextLoadout['passive'] !== undefined &&
    nextLoadout['active-four'] === undefined
  ) {
    nextLoadout['active-four'] = nextLoadout['passive'];
  }
  delete nextLoadout['passive'];

  return nextLoadout;
}

function createGuestInventory() {
  const inventory = {};
  INVENTORY_KEYS.forEach((itemId) => {
    inventory[itemId] = MAX_GUEST_INVENTORY_COUNT;
  });
  return inventory;
}

function parseJson(value, defaultValue) {
  if (typeof value === 'object' && value !== null) {
    return value;
  }

  if (typeof value !== 'string' || value === '') {
    return defaultValue;
  }

  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? parsed : defaultValue;
  } catch {
    return defaultValue;
  }
}

function normalizeObject(value) {
  return parseJson(value, {});
}

function normalizeNumber(value, defaultValue) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function normalizeInteger(value, defaultValue) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : defaultValue;
}

function normalizeNonNegativeInteger(value, defaultValue) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : defaultValue;
}

function normalizeNonIncreasingInteger(value, defaultValue, maxValue) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return defaultValue;
  }
  return Math.min(parsed, maxValue);
}

function isValidInventoryKey(value) {
  return typeof value === 'string' && INVENTORY_KEYS.indexOf(value) !== -1;
}

function isValidLoadoutSlot(value) {
  return (
    value === 'active-one' ||
    value === 'active-two' ||
    value === 'active-three' ||
    value === 'active-four' ||
    value === 'passive'
  );
}

function createMockTransactionHash() {
  const random = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
  return `MOCKTX-${Date.now().toString(36)}-${random}`;
}

function isValidPlayerId(value) {
  return typeof value === 'string' && /^ply-[a-z0-9-]+$/i.test(value);
}

function isValidPlayer(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    isValidPlayerId(value.id) &&
    (value.provider === 'guest' ||
      value.provider === 'wallet' ||
      value.provider === 'google')
  );
}

module.exports = {
  creditFuel,
  creditRewards,
  debitFuel,
  debitTokens,
  ensureAccountForPlayer,
  purchaseItemForPlayer,
  readAccount,
  upsertAccountForPlayer,
  toPublicAccount,
  isPersistentStoreConfigured: hasPersistentConfig,
};
