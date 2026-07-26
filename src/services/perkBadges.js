const stakingStore = require('../stores/stakingStore');
const tradingStore = require('../stores/tradingStore');

// Perk badges for leaderboard rows: which visible perks a player holds.
// Now that boosts affect ranked matches, badges are how other players SEE why
// a run may have been boosted. Badge ids:
//   'stake-N' — staking perk tier N (N >= 1)
//   'boost'   — eligible trading volume inside the 30-day boost window
//
// One call resolves badges for a whole leaderboard page at once, so callers
// never loop per row.
async function getPerkBadges(playerIds) {
  const uniqueIds = Array.from(new Set(playerIds)).filter(
    (id) => typeof id === 'string' && id !== '',
  );

  const badges = {};
  uniqueIds.forEach((id) => {
    badges[id] = [];
  });

  if (uniqueIds.length === 0) {
    return badges;
  }

  await Promise.all([
    (async () => {
      for (const playerId of uniqueIds) {
        const staked = await stakingStore.getPlayerStake(playerId);
        const tier = stakingStore.getPerkTier(staked);
        if (tier.level >= 1) {
          badges[playerId].push(`stake-${tier.level}`);
        }
      }
    })(),
    (async () => {
      for (const playerId of uniqueIds) {
        const status = await tradingStore.getBoostStatus(playerId);
        if (status.totalVolumeUsd > 0) {
          badges[playerId].push('boost');
        }
      }
    })(),
  ]);

  return badges;
}

module.exports = { getPerkBadges };
