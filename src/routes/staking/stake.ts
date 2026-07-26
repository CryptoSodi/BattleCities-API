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

// Dev/off-chain staking: locks SOFT tokens from the economy account. The
// balance debit happens first; on any staking failure it is refunded. On-chain
// staking replaces this handler's internals later (Milestone 4 note).
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

  let body: any;
  try {
    body = await request.json();
  } catch {
    return createJsonResponse(request, { ok: false, error: 'Invalid JSON' }, 400);
  }

  const amount = Math.floor(Number(body?.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    return createJsonResponse(request, { ok: false, error: 'Invalid amount' }, 400);
  }

  const outcome = await database.withTransaction(async () => {
    const debited = await economyStore.debitTokens(player, amount);
    if (debited === null) {
      return { insufficient: true, result: null, account: null };
    }

    const result = await stakingStore.stake(player, amount);
    if (!result.ok) {
      await economyStore.creditRewards(player, { token: amount });
      return { insufficient: false, result, account: null };
    }

    return {
      insufficient: false,
      result,
      account: await economyStore.readAccount(player.id),
    };
  });

  if (outcome.insufficient) {
    return createJsonResponse(request, { ok: false, error: 'Not enough tokens' }, 400);
  }
  if (!outcome.result.ok) {
    return createJsonResponse(request, outcome.result, 400);
  }

  return createJsonResponse(request, {
    ...outcome.result,
    account: economyStore.toPublicAccount(outcome.account),
  });
}
