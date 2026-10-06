const matchResultStore = require('../stores/matchResultStore');
const competitions = require('./competitions');

const REWARD_INTERVAL_MINUTES = 30;

// The public board uses a server-side 30-minute scoring window. Distribution
// is deliberately gated behind the payout worker configuration: the browser
// can never decide recipients or sign a token transfer.
async function getLiveBoard(playerId = null) {
  const now = Date.now();
  const intervalMs = REWARD_INTERVAL_MINUTES * 60 * 1000;
  const periodStart = Math.floor(now / intervalMs) * intervalMs;
  const periodEnd = periodStart + intervalMs;
  const period = await competitions.ensureCurrent(now);
  const rows = await matchResultStore.getLeaderboardInWindow(
    null,
    new Date(periodStart).toISOString(),
    new Date(periodEnd).toISOString(),
    10,
    playerId,
  );

  return {
    enabled: isPayoutWorkerEnabled() && period.policy.enabled && !!period.policy.token,
    cycleId: period.id,
    currency: 'SKR',
    payoutEligibility: 'admin_reviewed_results_only',
    intervalStartedAt: new Date(periodStart).toISOString(),
    nextRewardAt: new Date(periodEnd).toISOString(),
    rewardIntervalMinutes: REWARD_INTERVAL_MINUTES,
    rows: rows.filter((row) => row.rank <= 10),
    currentPlayer: rows.find((row) => row.playerId === playerId) || null,
    tiers: period.policy.prizes,
  };
}

function isPayoutWorkerEnabled() {
  return process.env.BATTLECITY_LEADERBOARD_REWARDS_ENABLED === '1'
    && process.env.BATTLECITY_COMPETITIONS_WORKER_ENABLED === '1';
}

module.exports = { getLiveBoard, isPayoutWorkerEnabled };
