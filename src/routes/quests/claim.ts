declare const require: any;

import {
  createJsonResponse,
  createOptionsResponse,
  resolveSessionPlayer,
} from '../_helpers';

const database = require('../../database');
const playerPolicy = require('../../services/playerPolicy');
const economyStore = require('../../stores/economyStore');
const eventStore = require('../../stores/eventStore');
const rateLimiter = require('../../services/rateLimiter');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

// Claims a completed quest: event currency is credited by the event store,
// soft rewards (fuel/token) land on the economy account, everything hits the
// ledger. Idempotent per quest.
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


  if (!rateLimiter.allow('quest-claim', player.id)) {
    return createJsonResponse(request, { ok: false, error: 'Too many requests' }, 429);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return createJsonResponse(request, { ok: false, error: 'Invalid JSON' }, 400);
  }

  const outcome = await database.withTransaction(async () => {
    const result = await eventStore.claimQuest(player, body?.questId);
    if (!result.ok) {
      return { result, account: null };
    }

    if (result.reward.fuel > 0 || result.reward.token > 0) {
      await economyStore.creditRewards(player, {
        fuel: result.reward.fuel,
        token: result.reward.token,
      });
    }
    return { result, account: await economyStore.readAccount(player.id) };
  });
  if (!outcome.result.ok) {
    return createJsonResponse(request, outcome.result, 400);
  }

  return createJsonResponse(request, {
    ...outcome.result,
    account:
      outcome.account === null
        ? null
        : economyStore.toPublicAccount(outcome.account),
  });
}
