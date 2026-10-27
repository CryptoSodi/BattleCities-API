const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const storageConfig = require('../config/storageConfig');
const database = require('../database');
const ledgerStore = require('./ledgerStore');

const TABLE_NAME = 'battlecity_economy_accounts';
const localMutations = new Map();

// PostgreSQL mutations lock the account row inside the shared transaction.
// Local development serializes the complete balance/receipt operation per player.
function withAccountMutation(player, operation) {
  if (hasPersistentConfig()) return database.withTransaction(async () => operation(await refillFuel(await lockAccountForFuelMutation(player))));
  const previous = localMutations.get(player.id) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => operation(await refillFuel(await ensureStoredAccountForPlayer(player))));
  localMutations.set(player.id, next);
  return next.finally(() => { if (localMutations.get(player.id) === next) localMutations.delete(player.id); });
}
// Currency balances require real funds; account creation only grants fuel.
const SHOP_STARTING_TOKEN_BALANCE = 0;
const SHOP_STARTING_SOL_BALANCE = 0;
const SHOP_STARTING_FUEL_BALANCE = 5;
const FUEL_REFILL_INTERVAL_MS = 30 * 60 * 1000;
const SHOP_CATALOG = {
  'fuel-one': { price: 150, solPrice: 0.01, fuel: 1 },
  'fuel-five': { price: 600, solPrice: 0.04, fuel: 5 },
  'fuel-twenty': { price: 1800, solPrice: 0.12, fuel: 20 },
  shield: { price: 300, solPrice: 0.02, inventory: { shield: 1 } },
  'base-defence': { price: 375, solPrice: 0.025, inventory: { 'base-defence': 1 } },
  freeze: { price: 450, solPrice: 0.03, inventory: { freeze: 1 } },
  speed: { price: 450, solPrice: 0.03, inventory: { speed: 1 } },
  upgrade: { price: 675, solPrice: 0.045, inventory: { upgrade: 1 } },
  'zoom-out': { price: 375, solPrice: 0.025, inventory: { 'zoom-out': 1 } },
  wipeout: { price: 600, solPrice: 0.04, inventory: { wipeout: 1 } },
  'extra-life': { price: 525, solPrice: 0.035, inventory: { 'extra-life': 1 } },
  'max-healer': { price: 450, solPrice: 0.02, inventory: { 'max-healer': 1 } },
  'health-healer': { price: 450, solPrice: 0.01, inventory: { 'health-healer': 1 } },
  'rapid-shooter': { price: 450, solPrice: 0.01, inventory: { 'rapid-shooter': 1 } },
  'rapid-shooter-long': { price: 900, solPrice: 0.02, inventory: { 'rapid-shooter-long': 1 } },
  'starter-pack': {
    price: 1200,
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
  'max-healer', 'health-healer', 'rapid-shooter', 'rapid-shooter-long',
];
const ACTIVE_POWERUP_TYPES = {
  shield: 'shield',
  'base-defence': 'defence',
  freeze: 'freeze',
  speed: 'speed',
  upgrade: 'upgrade',
  'zoom-out': 'zoomout',
  wipeout: 'wipeout',
  'extra-life': 'life',
  'max-healer': 'healmax', 'health-healer': 'heal2',
  'rapid-shooter': 'rapid', 'rapid-shooter-long': 'rapidlong',
};

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
          created_at, updated_at, fuel_refill_at
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

// Materialize elapsed intervals on every authenticated account read or mutation.
// The row lock also protects the refill from simultaneous logins and match starts.
async function ensureAccountForPlayer(player) {
  if (!isValidPlayer(player)) throw new Error('Invalid player');
  return withAccountMutation(player, async account => account);
}

async function refillFuel(account) {
  const now = Date.now();
  const previous = Date.parse(account.fuelRefillAt);
  const intervals = Math.floor((now - previous) / FUEL_REFILL_INTERVAL_MS);
  if (intervals < 1) return account;
  const amount = Math.max(0, SHOP_STARTING_FUEL_BALANCE - account.fuelBalance);
  // Advance even when full: unused intervals never become banked grants.
  account.fuelRefillAt = new Date(previous + intervals * FUEL_REFILL_INTERVAL_MS).toISOString();
  account.fuelBalance += amount;
  account.updatedAt = new Date(now).toISOString();
  await writeAccount(account);
  if (amount > 0) await ledgerStore.appendEntries({
    playerId: account.playerId, walletAddress: account.walletAddress,
    currency: 'fuel', amount, reason: 'thirty-minute-fuel-refill',
    sourceType: 'fuel-refill', sourceId: account.fuelRefillAt,
  });
  return account;
}

async function ensureStoredAccountForPlayer(player) {
  if (!isValidPlayer(player)) {
    throw new Error('Invalid player');
  }

  const existing = await readAccount(player.id);
  // An account read must never write stale balances over a concurrent mutation.
  if (existing !== null) return existing;

  const now = new Date().toISOString();
  const account = normalizeAccount({
    playerId: player.id,
    provider: player.provider,
    walletAddress: player.walletAddress || null,
    tokenBalance: SHOP_STARTING_TOKEN_BALANCE,
    solBalance: SHOP_STARTING_SOL_BALANCE,
    fuelBalance: SHOP_STARTING_FUEL_BALANCE,
    inventory: {},
    loadout: {},
    createdAt: now,
    updatedAt: now,
    fuelRefillAt: now,
  });

  if (hasPersistentConfig()) {
    await ensureSchema();
    await getPgPool().query(`INSERT INTO ${TABLE_NAME}
      (player_id, provider, wallet_address, token_balance, sol_balance, fuel_balance,
       inventory_json, loadout_json, created_at, updated_at, fuel_refill_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$9,$9)
      ON CONFLICT (player_id) DO NOTHING`, [account.playerId, account.provider, account.walletAddress,
      account.tokenBalance, account.solBalance, account.fuelBalance, '{}', '{}', now]);
  } else {
    await ensureDataDir();
    const temporary = `${getAccountPath(player.id)}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(account), 'utf8');
    // Linking publishes the complete file atomically without replacing a racing creator.
    try { await fs.link(temporary, getAccountPath(player.id)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { await fs.unlink(temporary); }
  }
  return readAccount(player.id);
}

async function upsertAccountForPlayer(player, snapshot) {
  if (!isValidPlayer(player)) {
    throw new Error('Invalid player');
  }

  return withAccountMutation(player, async (existing) => {
    const nextSnapshot = typeof snapshot === 'object' && snapshot !== null ? snapshot : {};
    const normalized = normalizeSyncedAccount(existing, nextSnapshot, player);
    await writeAccount(normalized);
    return normalized;
  });
}

function getShopCatalogItem(itemId) {
  const item = SHOP_CATALOG[itemId];
  return item === undefined ? null : { ...item };
}

async function grantOnChainPurchaseForPlayer(
  player,
  itemId,
  paymentCurrency,
  signature,
  paymentWalletAddress,
  paidPrice = {},
) {
  if (!isValidPlayer(player)) {
    throw new Error('Invalid player');
  }

  const configuredItem = SHOP_CATALOG[itemId];
  if (configuredItem === undefined) {
    throw new Error('ITEM NOT FOUND');
  }
  const item = { ...configuredItem, ...paidPrice };

  return withAccountMutation(player, async (account) => {
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
    await appendPurchaseLedgerEntries(
      { ...account, walletAddress: paymentWalletAddress },
      item,
      itemId,
      paymentCurrency,
      signature,
    );
    return toPublicAccount(account);
  });
}

async function consumeFuelForPlayer(player, requestId, tankTier) {
  if (!isValidPlayer(player)) throw new Error('Invalid player');
  if (typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId)
      || !Number.isInteger(tankTier) || tankTier < 0 || tankTier > 3) {
    return { ok: false, status: 400, requestId, fuelConsumed: 0, error: 'Invalid request ID or tank tier' };
  }
  requestId = requestId.toLowerCase();
  const cost = tankTier + 1;
  return withAccountMutation(player, async (account) => {
    const sourceType = 'fuel-consumption';
    const previous = await ledgerStore.findEntryBySource(player.id, sourceType, requestId);
    if (previous) {
      const sameTier = previous.currency === 'fuel' && previous.amount === -cost;
      return { ok: sameTier, status: sameTier ? 200 : 409, requestId, fuelConsumed: sameTier ? cost : 0,
        idempotent: true, ...(sameTier ? {} : { error: 'Request ID already used for another tank tier' }),
        account: toPublicAccount(account) };
    }
    if (account.fuelBalance < cost) return { ok: false, status: 409, requestId, fuelConsumed: 0,
      error: 'Insufficient fuel', account: toPublicAccount(account) };
    account.fuelBalance -= cost;
    account.updatedAt = new Date().toISOString();
    await writeAccount(account);
    await ledgerStore.appendEntries({ playerId: player.id, walletAddress: player.walletAddress || null,
      currency: 'fuel', amount: -cost, reason: 'match-started', sourceType, sourceId: requestId });
    return { ok: true, status: 200, requestId, fuelConsumed: cost, idempotent: false, account: toPublicAccount(account) };
  });
}

async function consumePowerupForPlayer(
  player,
  itemId,
  expectedPowerupType,
  requestId,
) {
  if (!isValidPlayer(player)) {
    throw new Error('Invalid player');
  }

  const powerupType = ACTIVE_POWERUP_TYPES[itemId];
  if (powerupType === undefined || powerupType !== expectedPowerupType) {
    return { ok: false, statusText: 'INVALID POWERUP' };
  }
  if (
    typeof requestId !== 'string' ||
    !/^[a-z0-9:_-]{8,128}$/i.test(requestId)
  ) {
    return { ok: false, statusText: 'INVALID REQUEST' };
  }

  return withAccountMutation(player, async (account) => {
    const sourceType = 'powerup-consumption';
    const previous = await ledgerStore.findEntryBySource(
      player.id,
      sourceType,
      requestId,
    );

    if (previous !== null) {
      const samePowerup = previous.currency === `item:${itemId}`;
      return {
        ok: samePowerup,
        statusText: samePowerup ? 'POWERUP APPROVED' : 'REQUEST ALREADY USED',
        powerupType,
        idempotent: true,
        account: toPublicAccount(account),
      };
    }

    if ((account.inventory[itemId] || 0) <= 0) {
      return {
        ok: false,
        statusText: 'POWERUP NOT OWNED',
        powerupType,
        account: toPublicAccount(account),
      };
    }

    account.inventory[itemId] -= 1;
    if (account.inventory[itemId] <= 0) {
      account.inventory[itemId] = 0;
      Object.keys(account.loadout).forEach((slot) => {
        if (account.loadout[slot] === itemId) {
          delete account.loadout[slot];
        }
      });
    }
    account.updatedAt = new Date().toISOString();
    await writeAccount(account);
    await ledgerStore.appendEntries({
      playerId: player.id,
      walletAddress: player.walletAddress || null,
      currency: `item:${itemId}`,
      amount: -1,
      reason: 'powerup-consumed',
      sourceType,
      sourceId: requestId,
    });

    return {
      ok: true,
      statusText: 'POWERUP APPROVED',
      powerupType,
      consumed: true,
      remaining: account.inventory[itemId],
      account: toPublicAccount(account),
    };
  });
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
      currency: paymentCurrency === 'sol' ? 'sol' : paymentCurrency === 'skr' ? 'skr' : 'token',
      amount: paymentCurrency === 'sol' ? -item.solPrice : paymentCurrency === 'skr' ? -item.skrPrice : -item.price,
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

async function creditFuel(player, amount, context = {}) {
  if (!isValidPlayer(player)) {
    throw new Error('Invalid player');
  }

  const safeAmount = Math.floor(Number(amount));
  if (!Number.isFinite(safeAmount) || safeAmount <= 0) {
    return ensureAccountForPlayer(player);
  }

  return withAccountMutation(player, async (account) => {
    if (hasPersistentConfig()) {
      const updated = await getPgPool().query(
        `
          UPDATE ${TABLE_NAME}
          SET fuel_balance = fuel_balance + $2, updated_at = $3
          WHERE player_id = $1
          RETURNING player_id, provider, wallet_address, token_balance,
            sol_balance, fuel_balance, inventory_json, loadout_json,
            created_at, updated_at, fuel_refill_at
        `,
        [player.id, safeAmount, new Date().toISOString()],
      );
      account = normalizeAccount(fromRow(updated.rows[0]));
    } else {
      account.fuelBalance += safeAmount;
      account.updatedAt = new Date().toISOString();
      await writeAccount(account);
    }

    await ledgerStore.appendEntries({
      playerId: player.id,
      walletAddress: player.walletAddress || null,
      currency: 'fuel',
      amount: safeAmount,
      reason: context.reason || 'fuel-reward',
      sourceType: context.sourceType || 'reward',
      sourceId: context.sourceId || null,
      eventId: context.eventId || null,
    });
    return account;
  });
}

async function lockAccountForFuelMutation(player) {
  await ensureSchema();
  let result = await getPgPool().query(
    `
      SELECT player_id, provider, wallet_address, token_balance,
        sol_balance, fuel_balance, inventory_json, loadout_json,
        created_at, updated_at, fuel_refill_at
      FROM ${TABLE_NAME}
      WHERE player_id = $1
      FOR UPDATE
    `,
    [player.id],
  );
  if (result.rowCount === 0) {
    await ensureStoredAccountForPlayer(player);
    result = await getPgPool().query(
      `
        SELECT player_id, provider, wallet_address, token_balance,
          sol_balance, fuel_balance, inventory_json, loadout_json,
          created_at, updated_at, fuel_refill_at
        FROM ${TABLE_NAME}
        WHERE player_id = $1
        FOR UPDATE
      `,
      [player.id],
    );
  }
  return normalizeAccount(fromRow(result.rows[0]));
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
            updated_at,
            fuel_refill_at
          )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)
        ON CONFLICT (player_id) DO UPDATE SET
          provider = EXCLUDED.provider,
          wallet_address = EXCLUDED.wallet_address,
          token_balance = EXCLUDED.token_balance,
          sol_balance = EXCLUDED.sol_balance,
          fuel_balance = EXCLUDED.fuel_balance,
          inventory_json = EXCLUDED.inventory_json,
          loadout_json = EXCLUDED.loadout_json,
          updated_at = EXCLUDED.updated_at,
          fuel_refill_at = EXCLUDED.fuel_refill_at
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
        normalized.fuelRefillAt,
      ],
    );
    return;
  }

  await ensureDataDir();
  const target = getAccountPath(normalized.playerId);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(normalized), 'utf8');
  await fs.rename(temporary, target);
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
    fuelRefillAt: new Date(row.fuel_refill_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function normalizeAccount(value) {
  const now = new Date().toISOString();
  const account = typeof value === 'object' && value !== null ? value : {};

  return {
    playerId: isValidPlayerId(account.playerId) ? account.playerId : '',
    provider: typeof account.provider === 'string' ? account.provider : '',
    walletAddress: typeof account.walletAddress === 'string' ? account.walletAddress : null,
    tokenBalance: normalizeNumber(account.tokenBalance, SHOP_STARTING_TOKEN_BALANCE),
    solBalance: normalizeNumber(account.solBalance, SHOP_STARTING_SOL_BALANCE),
    fuelBalance: normalizeInteger(account.fuelBalance, 0),
    inventory: normalizeObject(account.inventory),
    loadout: normalizeObject(account.loadout),
    fuelRefillAt: Number.isFinite(Date.parse(account.fuelRefillAt)) ? account.fuelRefillAt
      : (Number.isFinite(Date.parse(account.createdAt)) ? account.createdAt : now),
    createdAt: typeof account.createdAt === 'string' ? account.createdAt : now,
    updatedAt: typeof account.updatedAt === 'string' ? account.updatedAt : now,
  };
}

function normalizeSyncedAccount(existing, snapshot, player) {
  const nextInventory = normalizeSyncedInventory(existing.inventory, snapshot.inventory);
  const nextLoadout = normalizeSyncedLoadout(nextInventory, snapshot.loadout === undefined ? existing.loadout : snapshot.loadout);

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

function isValidPlayerId(value) {
  return typeof value === 'string' && /^ply-[a-z0-9-]+$/i.test(value);
}

function isValidPlayer(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    isValidPlayerId(value.id) &&
    (value.provider === 'wallet' || value.provider === 'guest')
  );
}

module.exports = {
  creditFuel,
  consumeFuelForPlayer,
  consumePowerupForPlayer,
  ensureAccountForPlayer,
  getShopCatalogItem,
  grantOnChainPurchaseForPlayer,
  readAccount,
  upsertAccountForPlayer,
  toPublicAccount,
  isPersistentStoreConfigured: hasPersistentConfig,
};
