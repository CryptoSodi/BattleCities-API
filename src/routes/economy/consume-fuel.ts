declare const require: any;
import { createJsonResponse, createOptionsResponse } from '../_helpers';
import { resolveSessionPlayer } from '../../middleware/session';
const economy = require('../../stores/economyStore');

export const OPTIONS = createOptionsResponse;

export async function POST(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  if (!player) return createJsonResponse(request, { ok: false, error: 'Not logged in' }, 401);
  let body: any;
  try { body = await request.json(); }
  catch { return createJsonResponse(request, { ok: false, error: 'Invalid JSON' }, 400); }
  const requestId = typeof body?.requestId === 'string' ? body.requestId : null;
  if (typeof body?.expectedPlayerId !== 'string' || !/^ply-[a-z0-9-]+$/i.test(body.expectedPlayerId)) {
    return createJsonResponse(request, { ok: false, requestId, fuelConsumed: 0, error: 'Invalid expected player ID' }, 400);
  }
  if (body.expectedPlayerId !== player.id) {
    return createJsonResponse(request, { ok: false, requestId, fuelConsumed: 0, error: 'Player session changed' }, 409);
  }
  const { status, ...result } = await economy.consumeFuelForPlayer(player, body?.requestId, body?.tankTier);
  return createJsonResponse(request, result, status);
}
