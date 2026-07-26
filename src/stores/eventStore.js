const fs = require('fs').promises;
const path = require('path');
const storageConfig = require('../config/storageConfig');
const database = require('../database');
const ledgerStore = require('./ledgerStore');

// Events, quests, quest progress, and event currencies (Milestone 3 of
// docs/mattle-inspired-infrastructure-plan.md). Events are config-driven
// records, not hardcoded scenes: each carries its quests, reward tracks, and
// event currency. Quest progress is driven by real match facts (metrics
// below); social quests can be added later as manual/claim-only metrics.
//
// Definitions (events/quests/tracks) are seeded server-side and read-only;
// per-player state (progress, claims, currency balances) is stored per player.
// Storage: Postgres when configured, local JSON otherwise.

const PROGRESS_TABLE = 'battlecity_quest_progress';
const CURRENCY_TABLE = 'battlecity_event_currency_balances';

// Quest metrics fed from validated match facts:
//   matches      - completed matches
//   wins         - matches won
//   levels       - levels cleared across matches
//   game-points  - accumulated server-derived Game Points
const QUEST_METRICS = ['matches', 'wins', 'levels', 'game-points'];

// Seeded definitions. Flavor follows the plan's renaming rules: tank
// operations instead of Heat Rush, medals/scrap instead of shells/ice cubes.
const EVENT_DEFINITIONS = [
  {
    id: 'evt-operation-iron-siege',
    slug: 'operation-iron-siege',
    name: 'OPERATION IRON SIEGE',
    description: 'COMPLETE OPERATIONS. COLLECT MEDALS. CLIMB THE RANKS.',
    startsAt: '2026-07-01T00:00:00.000Z',
    endsAt: '2026-08-15T00:00:00.000Z',
    entryFuelCost: 1,
    prizePool: '10000 BACT',
    currency: 'medals',
    quests: [
      {
        id: 'qst-first-sortie',
        name: 'FIRST SORTIE',
        description: 'COMPLETE 1 MATCH',
        metric: 'matches',
        target: 1,
        reward: { medals: 5, fuel: 1 },
      },
      {
        id: 'qst-front-breaker',
        name: 'FRONT BREAKER',
        description: 'CLEAR 3 LEVELS',
        metric: 'levels',
        target: 3,
        reward: { medals: 10, fuel: 2 },
      },
      {
        id: 'qst-decorated',
        name: 'DECORATED COMMANDER',
        description: 'EARN 2000 GAME POINTS',
        metric: 'game-points',
        target: 2000,
        reward: { medals: 25, token: 50 },
      },
      {
        id: 'qst-victor',
        name: 'SIEGE VICTOR',
        description: 'WIN 1 CAMPAIGN',
        metric: 'wins',
        target: 1,
        reward: { medals: 20, token: 25 },
      },
    ],
    rewardTracks: [
      { threshold: 10, reward: { fuel: 3 }, label: 'FUEL CACHE' },
      { threshold: 30, reward: { token: 100 }, label: 'SUPPLY DROP' },
      { threshold: 60, reward: { token: 300 }, label: 'WAR CHEST' },
    ],
  },
];

function getDataDir() {
  return (
    process.env.BATTLECITY_EVENT_DIR ||
    path.join(process.cwd(), 'server-data', 'events')
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

// ---------- definitions ----------

function listEvents() {
  return EVENT_DEFINITIONS.map(toPublicEvent);
}

function findEventBySlug(slug) {
  const event = EVENT_DEFINITIONS.find((entry) => entry.slug === slug);
  return event === undefined ? null : event;
}

function findQuest(questId) {
  for (const event of EVENT_DEFINITIONS) {
    const quest = event.quests.find((entry) => entry.id === questId);
    if (quest !== undefined) {
      return { event, quest };
    }
  }
  return null;
}

function resolveEventStatus(event) {
  const now = Date.now();
  if (now < Date.parse(event.startsAt)) {
    return 'upcoming';
  }
  if (now >= Date.parse(event.endsAt)) {
    return 'ended';
  }
  return 'live';
}

function toPublicEvent(event) {
  return {
    id: event.id,
    slug: event.slug,
    name: event.name,
    description: event.description,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    status: resolveEventStatus(event),
    entryFuelCost: Math.max(0, Math.floor(Number(event.entryFuelCost) || 0)),
    prizePool: event.prizePool,
    currency: event.currency,
    rewardTracks: event.rewardTracks,
  };
}

// ---------- per-player state ----------

async function readPlayerState(playerId) {
  if (hasPersistentConfig()) {
    await ensureSchema();
    const [progressResult, currencyResult] = await Promise.all([
      getPgPool().query(
        `SELECT quest_id, value, claimed_at FROM ${PROGRESS_TABLE} WHERE player_id = $1`,
        [playerId],
      ),
      getPgPool().query(
        `SELECT event_id, currency, amount FROM ${CURRENCY_TABLE} WHERE player_id = $1`,
        [playerId],
      ),
    ]);

    const progress = {};
    progressResult.rows.forEach((row) => {
      progress[row.quest_id] = {
        value: Number(row.value),
        claimedAt:
          row.claimed_at === null ? null : new Date(row.claimed_at).toISOString(),
      };
    });

    const currencies = {};
    currencyResult.rows.forEach((row) => {
      currencies[`${row.event_id}:${row.currency}`] = Number(row.amount);
    });

    return { progress, currencies };
  }

  try {
    const raw = await fs.readFile(getPlayerStatePath(playerId), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      progress:
        typeof parsed.progress === 'object' && parsed.progress !== null
          ? parsed.progress
          : {},
      currencies:
        typeof parsed.currencies === 'object' && parsed.currencies !== null
          ? parsed.currencies
          : {},
    };
  } catch {
    return { progress: {}, currencies: {} };
  }
}

async function writePlayerState(player, state) {
  if (hasPersistentConfig()) {
    await ensureSchema();
    for (const questId of Object.keys(state.progress)) {
      const entry = state.progress[questId];
      await getPgPool().query(
        `
          INSERT INTO ${PROGRESS_TABLE} (player_id, quest_id, value, claimed_at, updated_at)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (player_id, quest_id) DO UPDATE SET
            value = EXCLUDED.value,
            claimed_at = EXCLUDED.claimed_at,
            updated_at = EXCLUDED.updated_at
        `,
        [player.id, questId, entry.value, entry.claimedAt, new Date().toISOString()],
      );
    }

    for (const key of Object.keys(state.currencies)) {
      const [eventId, currency] = key.split(':');
      await getPgPool().query(
        `
          INSERT INTO ${CURRENCY_TABLE}
            (player_id, event_id, currency, amount, display_name, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (player_id, event_id, currency) DO UPDATE SET
            amount = EXCLUDED.amount,
            display_name = EXCLUDED.display_name,
            updated_at = EXCLUDED.updated_at
        `,
        [
          player.id,
          eventId,
          currency,
          state.currencies[key],
          player.displayName || 'Player',
          new Date().toISOString(),
        ],
      );
    }
    return;
  }

  await fs.mkdir(getDataDir(), { recursive: true });
  await fs.writeFile(
    getPlayerStatePath(player.id),
    JSON.stringify({
      displayName: player.displayName || 'Player',
      progress: state.progress,
      currencies: state.currencies,
    }),
    'utf8',
  );
}

function getPlayerStatePath(playerId) {
  return path.join(getDataDir(), `${playerId}.json`);
}

// Feeds a completed (server-derived) match result into every LIVE event's
// metric quests. Progress on claimed quests is frozen.
async function applyMatchResult(player, result) {
  if (!isValidPlayer(player)) {
    return;
  }

  const deltas = {
    matches: 1,
    wins: result.won === true ? 1 : 0,
    levels: Math.max(0, Number(result.levelNumber) - 1 || 0),
    'game-points': Math.max(0, Number(result.gamePoints) || 0),
  };

  const state = await readPlayerState(player.id);
  let changed = false;

  for (const event of EVENT_DEFINITIONS) {
    if (resolveEventStatus(event) !== 'live') {
      continue;
    }

    for (const quest of event.quests) {
      if (!QUEST_METRICS.includes(quest.metric)) {
        continue;
      }

      const entry = state.progress[quest.id] || { value: 0, claimedAt: null };
      if (entry.claimedAt !== null) {
        continue;
      }

      const delta = deltas[quest.metric] || 0;
      if (delta <= 0) {
        continue;
      }

      entry.value = Math.min(quest.target, entry.value + delta);
      state.progress[quest.id] = entry;
      changed = true;
    }
  }

  if (changed) {
    await writePlayerState(player, state);
  }
}

// Claims a completed quest: marks it claimed (idempotent), credits event
// currency, and returns the soft rewards (fuel/token) the caller must apply
// to the economy account. Every reward is also written to the ledger.
async function claimQuest(player, questId) {
  if (!isValidPlayer(player)) {
    return { ok: false, error: 'Invalid player' };
  }

  const found = findQuest(questId);
  if (found === null) {
    return { ok: false, error: 'Quest not found' };
  }

  const { event, quest } = found;
  const state = await readPlayerState(player.id);
  const entry = state.progress[quest.id] || { value: 0, claimedAt: null };

  if (entry.claimedAt !== null) {
    return { ok: false, error: 'Already claimed' };
  }
  if (entry.value < quest.target) {
    return { ok: false, error: 'Quest not complete' };
  }

  entry.claimedAt = new Date().toISOString();
  state.progress[quest.id] = entry;

  const reward = quest.reward || {};
  const currencyAmount = Number(reward[event.currency]) || 0;
  if (currencyAmount > 0) {
    const key = `${event.id}:${event.currency}`;
    state.currencies[key] = (Number(state.currencies[key]) || 0) + currencyAmount;
  }

  await writePlayerState(player, state);

  const ledgerBase = {
    playerId: player.id,
    walletAddress: player.walletAddress || null,
    reason: 'quest-reward',
    sourceType: 'quest',
    sourceId: quest.id,
    eventId: event.id,
  };
  const ledgerEntries = [];
  if (currencyAmount > 0) {
    ledgerEntries.push({
      ...ledgerBase,
      currency: `event:${event.currency}`,
      amount: currencyAmount,
    });
  }
  if (Number(reward.fuel) > 0) {
    ledgerEntries.push({ ...ledgerBase, currency: 'fuel', amount: reward.fuel });
  }
  if (Number(reward.token) > 0) {
    ledgerEntries.push({ ...ledgerBase, currency: 'token', amount: reward.token });
  }
  await ledgerStore.appendEntries(ledgerEntries);

  return {
    ok: true,
    quest: { id: quest.id, name: quest.name },
    reward: {
      currency: event.currency,
      currencyAmount,
      fuel: Number(reward.fuel) || 0,
      token: Number(reward.token) || 0,
    },
  };
}

// Quests + progress for one player across live events (or one event).
async function getQuestBoard(player, slug = null) {
  const state =
    player === null
      ? { progress: {}, currencies: {} }
      : await readPlayerState(player.id);

  const events =
    slug === null
      ? EVENT_DEFINITIONS
      : EVENT_DEFINITIONS.filter((event) => event.slug === slug);

  return events.map((event) => ({
    ...toPublicEvent(event),
    currencyBalance:
      Number(state.currencies[`${event.id}:${event.currency}`]) || 0,
    quests: event.quests.map((quest) => {
      const entry = state.progress[quest.id] || { value: 0, claimedAt: null };
      return {
        id: quest.id,
        name: quest.name,
        description: quest.description,
        metric: quest.metric,
        target: quest.target,
        reward: quest.reward,
        value: entry.value,
        completed: entry.value >= quest.target,
        claimedAt: entry.claimedAt,
      };
    }),
  }));
}

// Event leaderboard by event currency.
async function getEventLeaderboard(slug, limit = 20) {
  const event = findEventBySlug(slug);
  if (event === null) {
    return null;
  }

  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));

  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `
        SELECT player_id, display_name, amount
        FROM ${CURRENCY_TABLE}
        WHERE event_id = $1 AND currency = $2
        ORDER BY amount DESC, player_id ASC
        LIMIT $3
      `,
      [event.id, event.currency, safeLimit],
    );

    return result.rows.map((row, index) => ({
      rank: index + 1,
      playerId: row.player_id,
      displayName: row.display_name,
      amount: Number(row.amount),
    }));
  }

  let files;
  try {
    files = await fs.readdir(getDataDir());
  } catch {
    return [];
  }

  const rows = [];
  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue;
    }

    try {
      const parsed = JSON.parse(
        await fs.readFile(path.join(getDataDir(), file), 'utf8'),
      );
      const amount =
        Number(parsed?.currencies?.[`${event.id}:${event.currency}`]) || 0;
      if (amount > 0) {
        rows.push({
          playerId: file.replace(/\.json$/, ''),
          displayName: parsed.displayName || 'Player',
          amount,
        });
      }
    } catch {
      // Ignore malformed state files.
    }
  }

  return rows
    .sort((a, b) => b.amount - a.amount || (a.playerId < b.playerId ? -1 : 1))
    .slice(0, safeLimit)
    .map((row, index) => ({ rank: index + 1, ...row }));
}

async function getPlayerEventRank(playerId, slug) {
  const event = findEventBySlug(slug);
  if (event === null) {
    return null;
  }

  const board = await getEventLeaderboard(slug, 100);
  const me = board.find((row) => row.playerId === playerId);
  return me === undefined ? null : { rank: me.rank, amount: me.amount };
}

function isValidPlayer(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.id === 'string' &&
    /^ply-[a-z0-9-]+$/i.test(value.id)
  );
}

module.exports = {
  applyMatchResult,
  claimQuest,
  getEventLeaderboard,
  getPlayerEventRank,
  getQuestBoard,
  findEventBySlug,
  listEvents,
  toPublicEvent,
  isPersistentStoreConfigured: hasPersistentConfig,
};
