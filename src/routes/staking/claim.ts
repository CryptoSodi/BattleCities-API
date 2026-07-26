declare const require: any;

import {
  createJsonResponse,
  createOptionsResponse,
  resolveSessionPlayer,
} from '../_helpers';

const database = require('../../database');
const playerPolicy = require('../../services/playerPolicy');
const economyStore = require('../../stores/economyStore');
const rateLimiter = require('../../services/rateLimiter');
const stakingStore = require('../../stores/stakingStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

// Claims every matured unstake position back to the economy token balance.
// Epoch REWARD claiming stays disabled until the revenue split ships real
// pools (plan: no payout promises before that's decided).
export async function POST(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  if (player === null) {
    return createJsonResponse(request, { ok: false, error: 'Not logged in' }, 401);
  }

  if (playerPolicy.isVirtualPlayer(player)) {
    return createJsonResponse(
      request,
      { ok: false, error: playerPolicy.VIRTUAL_PLAYER_MESSAGE },
      403,
    );
  }


  if (!rateLimiter.allow('staking-action', player.id)) {
    return createJsonResponse(request, { ok: false, error: 'Too many requests' }, 429);
  }

  const outcome = await database.withTransaction(async () => {
    const result = await stakingStore.claimUnstaked(player);
    if (result.ok && result.amount > 0) {
      await economyStore.creditRewards(player, { token: result.amount });
    }
    return { result, account: await economyStore.readAccount(player.id) };
  });
  return createJsonResponse(request, {
    ...outcome.result,
    account:
      outcome.account === null
        ? null
        : economyStore.toPublicAccount(outcome.account),
  });
}
