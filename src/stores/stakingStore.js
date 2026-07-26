const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const storageConfig = require('../config/storageConfig');
const database = require('../database');
const ledgerStore = require('./ledgerStore');

// Utility staking V1 (Milestone 4). Dev/off-chain first, per the plan: players
// lock SOFT tokens from their economy account; on-chain staking arrives later
// behind the same interface. Mechanics follow the Mattle model the doc
// specifies:
//   - 1 staked token = 1 SP per day; dailySP = end-of-day staked amount.
//   - Rewards run in fixed 30-day epochs; SP resets each epoch.
//   - userReward = userTotalSP / totalSP * epochRewardPool.
//   - Unstaking stops SP for that amount and starts a 10-day cooldown.
// Daily snapshots are computed LAZILY and idempotently: any staking call
// first catches up all elapsed snapshot days for the active epoch, so no cron
// is needed in dev. Perk tiers mirror the plan's Boost page table.

const STATE_FILE = 'staking.json';
const TABLE_NAME = 'battlecity_staking_state';
const EPOCH_LENGTH_DAYS = 30;
const UNSTAKE_COOLDOWN_DAYS = 10;
const EPOCH_REWARD_POOL = 10000; // soft tokens, funded by shop revenue split

const PERK_TIERS = [
  { level: 0, stake: 0, hull: 0, armor: 0, engine: 0, salvage: 0 },
  { level: 1, stake: 2000, hull: 2, armor: 3, engine: 2, salvage: 3 },
  { level: 2, stake: 10000, hull: 5, armor: 8, engine: 5, salvage: 8 },
  { level: 3, stake: 50000, hull: 10, armor: 15, engine: 10, salvage: 15 },
  { level: 4, stake: 200000, hull: 20, armor: 30, engine: 20, salvage: 30 },
];

function getDataDir() {
  return (
    process.env.BATTLECITY_STAKING_DIR ||
    path.join(process.cwd(), 'server-data', 'staking')
  );
}

function hasPersistentConfig() {
  return storageConfig.hasDatabaseConfig();
}

function getPgPool() {
  return database.getPool();
}

// The whole staking world is one JSON document: the active epoch, per-player
// positions/SP, and pending unstakes. At this milestone's scale (dev soft
// tokens) a single document keeps snapshot catch-up atomic and trivially
// idempotent; it can split into the plan's separate tables when on-chain
// staking lands.
async function ensureSchema() {
  await database.assertMigrationsApplied();
}

async function readState() {
  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `SELECT state_json FROM ${TABLE_NAME} WHERE id = 1 LIMIT 1`,
    );
    if (result.rowCount > 0) {
      return normalizeState(result.rows[0].state_json);
    }
    return normalizeState(null);
  }

  try {
    const raw = await fs.readFile(path.join(getDataDir(), STATE_FILE), 'utf8');
    return normalizeState(JSON.parse(raw));
  } catch {
    return normalizeState(null);
  }
}

async function writeState(state) {
  if (hasPersistentConfig()) {
    await ensureSchema();
    await getPgPool().query(
      `
        INSERT INTO ${TABLE_NAME} (id, state_json, updated_at)
        VALUES (1, $1::jsonb, $2)
        ON CONFLICT (id) DO UPDATE SET
          state_json = EXCLUDED.state_json,
          updated_at = EXCLUDED.updated_at
      `,
      [JSON.stringify(state), new Date().toISOString()],
    );
    return;
  }

  await fs.mkdir(getDataDir(), { recursive: true });
  await fs.writeFile(
    path.join(getDataDir(), STATE_FILE),
    JSON.stringify(state),
    'utf8',
  );
}

function normalizeState(value) {
  const state = typeof value === 'object' && value !== null ? value : {};
  return {
    epoch: state.epoch || null,
    // playerId -> { displayName, staked, totalSp, latestSp }
    players:
      typeof state.players === 'object' && state.players !== null
        ? state.players
        : {},
    // [{ id, playerId, amount, requestedAt, claimableAt, claimedAt }]
    unstakes: Array.isArray(state.unstakes) ? state.unstakes : [],
  };
}

function utcDateKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function createEpoch(number, startsAtMs) {
  return {
    id: `epoch-${number}`,
    number,
    startsAt: new Date(startsAtMs).toISOString(),
    endsAt: new Date(
      startsAtMs + EPOCH_LENGTH_DAYS * 24 * 3600 * 1000,
    ).toISOString(),
    rewardPool: EPOCH_REWARD_POOL,
    // Last UTC date (YYYY-MM-DD) a daily snapshot ran for; snapshots are
    // idempotent because a day can only be consumed once.
    lastSnapshotDate: null,
    totalSp: 0,
  };
}

// Catch up: roll epochs forward and apply one dailySP grant per elapsed UTC
// day since the last snapshot. SP resets when an epoch rolls over.
function catchUpSnapshots(state) {
  const now = Date.now();

  if (state.epoch === null) {
    const todayStart = Date.parse(`${utcDateKey(now)}T00:00:00.000Z`);
    state.epoch = createEpoch(1, todayStart);
  }

  let guard = 0;
  while (guard < 1000) {
    guard += 1;

    const epochEnd = Date.parse(state.epoch.endsAt);
    const snapshotUntil = Math.min(now, epochEnd - 1);
    const lastDate =
      state.epoch.lastSnapshotDate || utcDateKey(Date.parse(state.epoch.startsAt));

    // Snapshot every fully elapsed UTC day after lastDate, up to yesterday
    // relative to snapshotUntil (the plan snapshots end-of-day balances).
    let cursor = Date.parse(`${lastDate}T00:00:00.000Z`) + 24 * 3600 * 1000;
    while (cursor + 24 * 3600 * 1000 <= snapshotUntil + 1) {
      const dateKey = utcDateKey(cursor);
      Object.keys(state.players).forEach((playerId) => {
        const player = state.players[playerId];
        const dailySp = Math.max(0, Number(player.staked) || 0);
        if (dailySp > 0) {
          player.latestSp = dailySp;
          player.totalSp = (Number(player.totalSp) || 0) + dailySp;
          state.epoch.totalSp = (Number(state.epoch.totalSp) || 0) + dailySp;
        }
      });
      state.epoch.lastSnapshotDate = dateKey;
      cursor += 24 * 3600 * 1000;
    }

    if (now < epochEnd) {
      break;
    }

    // Epoch rollover: reset SP for the new epoch (claim history for closed
    // epochs is out of scope until real rewards ship).
    Object.keys(state.players).forEach((playerId) => {
      state.players[playerId].totalSp = 0;
      state.players[playerId].latestSp = 0;
    });
    state.epoch = createEpoch(state.epoch.number + 1, epochEnd);
  }

  // Release matured unstakes is handled at claim time; nothing else to do.
  return state;
}

async function withState(mutate) {
  const state = catchUpSnapshots(await readState());
  const result = await mutate(state);
  await writeState(state);
  return result;
}

// ---------- actions (dev/off-chain: amounts are SOFT tokens) ----------

// Locks `amount` for the player. The caller must have already debited the
// player's economy token balance.
async function stake(player, amount) {
  const safeAmount = Math.floor(Number(amount));
  if (!Number.isFinite(safeAmount) || safeAmount <= 0) {
    return { ok: false, error: 'Invalid amount' };
  }

  return withState(async (state) => {
    const entry = state.players[player.id] || {
      displayName: player.displayName || 'Player',
      staked: 0,
      totalSp: 0,
      latestSp: 0,
    };
    entry.staked = (Number(entry.staked) || 0) + safeAmount;
    entry.displayName = player.displayName || entry.displayName;
    state.players[player.id] = entry;

    await ledgerStore.appendEntries({
      playerId: player.id,
      walletAddress: player.walletAddress || null,
      currency: 'token',
      amount: -safeAmount,
      reason: 'stake-lock',
      sourceType: 'staking',
      sourceId: state.epoch.id,
    });

    return { ok: true, staked: entry.staked };
  });
}

// Starts the 10-day cooldown for `amount`; SP stops for it immediately.
async function unstake(player, amount) {
  const safeAmount = Math.floor(Number(amount));
  if (!Number.isFinite(safeAmount) || safeAmount <= 0) {
    return { ok: false, error: 'Invalid amount' };
  }

  return withState(async (state) => {
    const entry = state.players[player.id];
    if (entry === undefined || (Number(entry.staked) || 0) < safeAmount) {
      return { ok: false, error: 'Not enough staked' };
    }

    entry.staked -= safeAmount;
    const now = Date.now();
    state.unstakes.push({
      id: `uns-${now.toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
      playerId: player.id,
      amount: safeAmount,
      requestedAt: new Date(now).toISOString(),
      claimableAt: new Date(
        now + UNSTAKE_COOLDOWN_DAYS * 24 * 3600 * 1000,
      ).toISOString(),
      claimedAt: null,
    });

    return { ok: true, staked: entry.staked };
  });
}

// Claims every matured unstake position; returns the total token amount the
// caller must credit back to the economy account. Idempotent per position.
async function claimUnstaked(player) {
  return withState(async (state) => {
    const now = Date.now();
    let total = 0;

    state.unstakes.forEach((position) => {
      if (
        position.playerId === player.id &&
        position.claimedAt === null &&
        Date.parse(position.claimableAt) <= now
      ) {
        position.claimedAt = new Date(now).toISOString();
        total += Number(position.amount) || 0;
      }
    });

    if (total > 0) {
      await ledgerStore.appendEntries({
        playerId: player.id,
        walletAddress: player.walletAddress || null,
        currency: 'token',
        amount: total,
        reason: 'unstake-claim',
        sourceType: 'staking',
        sourceId: state.epoch.id,
      });
    }

    return { ok: true, amount: total };
  });
}

// ---------- queries ----------

async function getSummary(playerId) {
  return withState(async (state) => {
    const epoch = state.epoch;
    const dayMs = Date.now() - Date.parse(epoch.startsAt);
    const day = Math.min(
      EPOCH_LENGTH_DAYS,
      Math.max(1, Math.floor(dayMs / (24 * 3600 * 1000)) + 1),
    );

    let lockedTokens = 0;
    Object.keys(state.players).forEach((id) => {
      lockedTokens += Number(state.players[id].staked) || 0;
    });

    const me =
      playerId !== null && state.players[playerId] !== undefined
        ? state.players[playerId]
        : { staked: 0, totalSp: 0, latestSp: 0 };
    const estimatedReward =
      epoch.totalSp > 0
        ? Math.floor((me.totalSp / epoch.totalSp) * epoch.rewardPool)
        : 0;

    const myUnstakes = state.unstakes
      .filter(
        (position) =>
          position.playerId === playerId && position.claimedAt === null,
      )
      .map((position) => ({
        id: position.id,
        amount: position.amount,
        claimableAt: position.claimableAt,
        claimable: Date.parse(position.claimableAt) <= Date.now(),
      }));

    return {
      epoch: {
        id: epoch.id,
        number: epoch.number,
        day,
        lengthDays: EPOCH_LENGTH_DAYS,
        startsAt: epoch.startsAt,
        endsAt: epoch.endsAt,
        rewardPool: epoch.rewardPool,
        totalSp: epoch.totalSp,
      },
      community: { lockedTokens },
      me: {
        staked: Number(me.staked) || 0,
        latestSp: Number(me.latestSp) || 0,
        totalSp: Number(me.totalSp) || 0,
        estimatedReward,
        perkTier: getPerkTier(Number(me.staked) || 0),
      },
      unstakes: myUnstakes,
      perkTiers: PERK_TIERS,
    };
  });
}

async function getLeaderboard(limit = 20) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));

  return withState(async (state) => {
    return Object.keys(state.players)
      .map((playerId) => ({
        playerId,
        displayName: state.players[playerId].displayName || 'Player',
        staked: Number(state.players[playerId].staked) || 0,
        totalSp: Number(state.players[playerId].totalSp) || 0,
      }))
      .filter((row) => row.staked > 0 || row.totalSp > 0)
      .sort(
        (a, b) =>
          b.totalSp - a.totalSp ||
          b.staked - a.staked ||
          (a.playerId < b.playerId ? -1 : 1),
      )
      .slice(0, safeLimit)
      .map((row, index) => ({ rank: index + 1, ...row }));
  });
}

// Perk tier for a staked amount — the highest tier whose threshold is met.
function getPerkTier(stakedAmount) {
  let tier = PERK_TIERS[0];
  for (const candidate of PERK_TIERS) {
    if (stakedAmount >= candidate.stake) {
      tier = candidate;
    }
  }
  return tier;
}

async function getPlayerStake(playerId) {
  const state = catchUpSnapshots(await readState());
  const entry = state.players[playerId];
  return entry === undefined ? 0 : Number(entry.staked) || 0;
}

module.exports = {
  claimUnstaked,
  getLeaderboard,
  getPerkTier,
  getPlayerStake,
  getSummary,
  stake,
  unstake,
  isPersistentStoreConfigured: hasPersistentConfig,
};
