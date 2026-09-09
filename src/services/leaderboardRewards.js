const matchResultStore = require('../stores/matchResultStore');
const seasonStore = require('../stores/seasonStore');

const REWARD_INTERVAL_MINUTES = 30;
const REWARD_TIERS = Object.freeze([
  { fromRank: 1, toRank: 1, amount: 1000 },
  { fromRank: 2, toRank: 2, amount: 750 },
  { fromRank: 3, toRank: 3, amount: 500 },
  { fromRank: 4, toRank: 10, amount: 250 },
]);

// The public board uses a server-side 30-minute scoring window. Distribution
// is deliberately gated behind the payout worker configuration: the browser
// can never decide recipients or sign a token transfer.
async function getLiveBoard(playerId = null) {
  const now = Date.now();
  const intervalMs = REWARD_INTERVAL_MINUTES * 60 * 1000;
  const periodStart = Math.floor(now / intervalMs) * intervalMs;
  const periodEnd = periodStart + intervalMs;
  const season = await seasonStore.getCurrentSeason();
  const rows = await matchResultStore.getLeaderboardInWindow(
    season.id,
    new Date(periodStart).toISOString(),
    new Date(periodEnd).toISOString(),
    10,
    playerId,
  );

  return {
    enabled: isPayoutWorkerEnabled(),
    intervalStartedAt: new Date(periodStart).toISOString(),
    nextRewardAt: new Date(periodEnd).toISOString(),
    rewardIntervalMinutes: REWARD_INTERVAL_MINUTES,
    rows: rows.filter((row) => row.rank <= 10),
    currentPlayer: rows.find((row) => row.playerId === playerId) || null,
    tiers: REWARD_TIERS,
  };
}

function isPayoutWorkerEnabled() {
  return process.env.BATTLECITY_LEADERBOARD_REWARDS_ENABLED === '1';
}

module.exports = { getLiveBoard, isPayoutWorkerEnabled, REWARD_TIERS };
