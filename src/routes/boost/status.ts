declare const require: any;

import {
  createJsonResponse,
  createOptionsResponse,
  resolveSessionPlayer,
} from '../_helpers';

const stakingStore = require('../../stores/stakingStore');
const tradingStore = require('../../stores/tradingStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

// The Boost dashboard: 30-day trading boosts, staking perk tier, shop perks
// (empty until the shop sells perk items), and where each perk applies.
// Boosts apply EVERYWHERE including ranked matches (user decision overriding
// the plan's original ranked-fairness split) — the response says so
// explicitly so the client can label perks honestly.
export async function GET(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);

  if (player === null) {
    return createJsonResponse(request, { authenticated: false });
  }

  const [trading, stakingSummary] = await Promise.all([
    tradingStore.getBoostStatus(player.id),
    stakingStore.getSummary(player.id),
  ]);

  return createJsonResponse(request, {
    authenticated: true,
    appliesTo: ['ranked', 'events', 'arcade'],
    rankedAffected: true,
    trading,
    staking: {
      tier: stakingSummary.me.perkTier,
      staked: stakingSummary.me.staked,
      nextTier:
        stakingSummary.perkTiers.find(
          (tier: any) => tier.stake > stakingSummary.me.staked,
        ) || null,
    },
    shopPerks: [],
  });
}
