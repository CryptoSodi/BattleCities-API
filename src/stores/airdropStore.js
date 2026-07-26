const fs = require('fs').promises;
const path = require('path');
const storageConfig = require('../config/storageConfig');
const database = require('../database');
const ledgerStore = require('./ledgerStore');

// Airdrops as an ELIGIBILITY + ALLOCATION system first (Milestone 6); the
// on-chain claim (Merkle distributor) comes later. Eligibility weight blends
// all-time Game Points, staking SP, and 30-day trading volume with campaign-
// configured weights. Allocations can be frozen by an admin script — after a
// freeze, eligibility answers come from the stored snapshot so they can never
// shift. Claims are idempotent state markers until real distribution exists.

const CAMPAIGN_DEFINITIONS = [
  {
    id: 'drp-founding-commanders',
    slug: 'founding-commanders',
    name: 'FOUNDING COMMANDERS',
    startsAt: '2026-07-01T00:00:00.000Z',
    endsAt: '2026-10-01T00:00:00.000Z',
    allocationPool: 1000000, // BACT
    rules: {
      gamePointsWeight: 1, // 1 weight per game point
      stakingSpWeight: 0.1, // 1 weight per 10 SP
      tradingUsdWeight: 2, // 2 weight per $1 eligible volume
    },
  },
];

const TABLE_NAME = 'battlecity_airdrop_state';

function getDataDir() {
  return (
    process.env.BATTLECITY_AIRDROP_DIR ||
    path.join(process.cwd(), 'server-data', 'airdrops')
  );
}

function hasPersistentConfig() {
  return storageConfig.hasDatabaseConfig();
}

function getPgPool() {
  return database.getPool();
}

// One state document per campaign: frozen allocations + claim markers.
async function ensureSchema() {
  await database.assertMigrationsApplied();
}

function listCampaigns() {
  return CAMPAIGN_DEFINITIONS.map(toPublicCampaign);
}

function findCampaignBySlug(slug) {
  return CAMPAIGN_DEFINITIONS.find((entry) => entry.slug === slug) || null;
}

function toPublicCampaign(campaign) {
  const now = Date.now();
  let status = 'live';
  if (now < Date.parse(campaign.startsAt)) {
    status = 'upcoming';
  } else if (now >= Date.parse(campaign.endsAt)) {
    status = 'ended';
  }

  return {
    id: campaign.id,
    slug: campaign.slug,
    name: campaign.name,
    startsAt: campaign.startsAt,
    endsAt: campaign.endsAt,
    status,
    allocationPool: campaign.allocationPool,
  };
}

async function readCampaignState(campaignId) {
  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `SELECT state_json FROM ${TABLE_NAME} WHERE campaign_id = $1 LIMIT 1`,
      [campaignId],
    );
    return normalizeCampaignState(
      result.rowCount > 0 ? result.rows[0].state_json : null,
    );
  }

  try {
    const raw = await fs.readFile(getCampaignPath(campaignId), 'utf8');
    return normalizeCampaignState(JSON.parse(raw));
  } catch {
    return normalizeCampaignState(null);
  }
}

async function writeCampaignState(campaignId, state) {
  if (hasPersistentConfig()) {
    await ensureSchema();
    await getPgPool().query(
      `
        INSERT INTO ${TABLE_NAME} (campaign_id, state_json, updated_at)
        VALUES ($1, $2::jsonb, $3)
        ON CONFLICT (campaign_id) DO UPDATE SET
          state_json = EXCLUDED.state_json,
          updated_at = EXCLUDED.updated_at
      `,
      [campaignId, JSON.stringify(state), new Date().toISOString()],
    );
    return;
  }

  await fs.mkdir(getDataDir(), { recursive: true });
  await fs.writeFile(getCampaignPath(campaignId), JSON.stringify(state), 'utf8');
}

function getCampaignPath(campaignId) {
  return path.join(getDataDir(), `${campaignId}.json`);
}

function normalizeCampaignState(value) {
  const state = typeof value === 'object' && value !== null ? value : {};
  return {
    frozenAt: typeof state.frozenAt === 'string' ? state.frozenAt : null,
    // playerId -> { weight, allocation, claimedAt }
    allocations:
      typeof state.allocations === 'object' && state.allocations !== null
        ? state.allocations
        : {},
  };
}

// Live (pre-freeze) weight for one player, computed from the other systems.
// The stat providers are injected so this store has no hard dependency cycle.
async function computeWeight(campaign, playerId, providers) {
  const [gamePoints, stakingSp, tradingUsd] = await Promise.all([
    providers.getAllTimeGamePoints(playerId),
    providers.getTotalStakingSp(playerId),
    providers.getTradingVolumeUsd(playerId),
  ]);

  const rules = campaign.rules;
  const weight =
    gamePoints * rules.gamePointsWeight +
    stakingSp * rules.stakingSpWeight +
    tradingUsd * rules.tradingUsdWeight;

  return {
    weight: Math.max(0, Math.round(weight)),
    parts: { gamePoints, stakingSp, tradingUsd },
  };
}

// Eligibility for one player: frozen snapshot when available, live estimate
// otherwise (allocation stays null until the freeze fixes the denominator).
async function getEligibility(slug, playerId, providers) {
  const campaign = findCampaignBySlug(slug);
  if (campaign === null) {
    return null;
  }

  const state = await readCampaignState(campaign.id);

  if (state.frozenAt !== null) {
    const entry = state.allocations[playerId] || null;
    return {
      campaign: toPublicCampaign(campaign),
      frozen: true,
      weight: entry === null ? 0 : entry.weight,
      allocation: entry === null ? 0 : entry.allocation,
      claimedAt: entry === null ? null : entry.claimedAt,
    };
  }

  const { weight, parts } = await computeWeight(campaign, playerId, providers);
  return {
    campaign: toPublicCampaign(campaign),
    frozen: false,
    weight,
    parts,
    allocation: null, // determined at freeze time
    claimedAt: null,
  };
}

// Admin/script action: snapshot every eligible player's weight and fix
// allocations proportionally. Idempotent — refuses to re-freeze.
async function freezeAllocations(slug, playerWeights) {
  const campaign = findCampaignBySlug(slug);
  if (campaign === null) {
    return { ok: false, error: 'Campaign not found' };
  }

  const state = await readCampaignState(campaign.id);
  if (state.frozenAt !== null) {
    return { ok: false, error: 'Already frozen' };
  }

  const entries = Object.keys(playerWeights)
    .map((playerId) => ({ playerId, weight: Math.max(0, Number(playerWeights[playerId]) || 0) }))
    .filter((entry) => entry.weight > 0);
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);

  entries.forEach((entry) => {
    state.allocations[entry.playerId] = {
      weight: entry.weight,
      allocation:
        totalWeight > 0
          ? Math.floor((entry.weight / totalWeight) * campaign.allocationPool)
          : 0,
      claimedAt: null,
    };
  });
  state.frozenAt = new Date().toISOString();

  await writeCampaignState(campaign.id, state);
  return { ok: true, players: entries.length, totalWeight };
}

// Marks a frozen allocation claimed (idempotent). On-chain distribution
// replaces the inside of this later; the state machine stays the same.
async function claim(slug, player) {
  const campaign = findCampaignBySlug(slug);
  if (campaign === null) {
    return { ok: false, error: 'Campaign not found' };
  }

  const state = await readCampaignState(campaign.id);
  if (state.frozenAt === null) {
    return { ok: false, error: 'Allocations not frozen yet' };
  }

  const entry = state.allocations[player.id];
  if (entry === undefined || entry.allocation <= 0) {
    return { ok: false, error: 'Nothing to claim' };
  }
  if (entry.claimedAt !== null) {
    return { ok: false, error: 'Already claimed' };
  }

  entry.claimedAt = new Date().toISOString();
  await writeCampaignState(campaign.id, state);

  await ledgerStore.appendEntries({
    playerId: player.id,
    walletAddress: player.walletAddress || null,
    currency: 'token',
    amount: entry.allocation,
    reason: 'airdrop-claim',
    sourceType: 'airdrop',
    sourceId: campaign.id,
  });

  return { ok: true, allocation: entry.allocation };
}

module.exports = {
  claim,
  computeWeight,
  findCampaignBySlug,
  freezeAllocations,
  getEligibility,
  listCampaigns,
  isPersistentStoreConfigured: hasPersistentConfig,
};
