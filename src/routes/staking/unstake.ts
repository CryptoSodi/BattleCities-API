declare const require: any;

import {
  createJsonResponse,
  createOptionsResponse,
  resolveSessionPlayer,
} from '../_helpers';

const playerPolicy = require('../../services/playerPolicy');
const rateLimiter = require('../../services/rateLimiter');
const stakingStore = require('../../stores/stakingStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

// Starts the 10-day cooldown; tokens return via /api/staking/claim.
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

  const result = await stakingStore.unstake(player, body?.amount);
  return createJsonResponse(request, result, result.ok ? 200 : 400);
}
