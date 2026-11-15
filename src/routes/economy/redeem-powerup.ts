declare const require: any;
import { createJsonResponse, createOptionsResponse } from '../_helpers';

const economy = require('../../stores/economyStore');
const players = require('../../stores/playerStore');

export function OPTIONS(request: Request): Response { return createOptionsResponse(request); }
export function GET(request: Request): Response { return createJsonResponse(request, { ok: true, version: 1 }); }
export async function POST(request: Request): Promise<Response> {
  let body: any;
  try { body = await request.json(); }
  catch { return createJsonResponse(request, { ok: false, statusText: 'INVALID JSON' }, 400); }
  const player = typeof body?.playerId === 'string' ? await players.readPlayer(body.playerId) : null;
  if (!player) return createJsonResponse(request, { ok: false, statusText: 'INVALID RECEIPT' }, 400);
  const result = await economy.redeemMultiplayerPowerup(player, body?.itemId, body?.requestId, body?.matchId);
  return createJsonResponse(request, result, result.ok ? 200 : 400);
}
