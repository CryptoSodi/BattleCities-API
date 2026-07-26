declare const require: any;

import {
  createJsonResponse,
  createOptionsResponse,
  resolveSessionPlayer,
} from '../_helpers';

const playerPolicy = require('../../services/playerPolicy');
const rateLimiter = require('../../services/rateLimiter');
const tradingStore = require('../../stores/tradingStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

// Records eligible swap volume, idempotent by transaction signature. Runs in
// mock verification mode until an RPC provider is picked (open decision) —
// see the note in stores/tradingStore.js.
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


  if (!rateLimiter.allow('swap-verify', player.id)) {
    return createJsonResponse(request, { ok: false, error: 'Too many requests' }, 429);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return createJsonResponse(request, { ok: false, error: 'Invalid JSON' }, 400);
  }

  const result = await tradingStore.recordSwap(player, body);
  return createJsonResponse(request, result, result.ok ? 200 : 400);
}
