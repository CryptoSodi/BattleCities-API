declare const require: any;

import {
  createJsonResponse,
  createOptionsResponse,
  resolveSessionPlayer,
} from '../_helpers';

const database = require('../../database');
const playerPolicy = require('../../services/playerPolicy');
const airdropStore = require('../../stores/airdropStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

// Marks a frozen allocation claimed (idempotent). On-chain distribution
// replaces the internals later; until then the claim is a ledgered state
// marker only — no real tokens move.
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


  let body: any;
  try {
    body = await request.json();
  } catch {
    return createJsonResponse(request, { ok: false, error: 'Invalid JSON' }, 400);
  }

  const result = await database.withTransaction(() =>
    airdropStore.claim(String(body?.slug || ''), player),
  );
  return createJsonResponse(request, result, result.ok ? 200 : 400);
}
