declare const require: any;

import { createJsonResponse, createOptionsResponse } from '../_helpers';

const batcDrops = require('../../services/batcPowerupDrops');
const playerStore = require('../../stores/playerStore');
const sessionIdentity = require('../../services/sessionIdentity');
const sessionStore = require('../../stores/sessionStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function POST(request: Request): Promise<Response> {
  const player = await resolvePlayer(request);
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json(request, { error: 'Invalid JSON.' }, 400);
  }

  try {
    const result = await batcDrops.roll(player, body?.requestId, body?.levelNumber);
    return json(request, result?.reward
      ? {
          eligible: true,
          dropType: result.dropType,
          claimId: result.reward.id,
          amount: result.reward.amount,
        }
      : { eligible: false, dropType: result?.dropType });
  } catch (error: any) {
    const status = error?.code === 'DROP_ROLL_LIMIT' ? 429 : 503;
    return json(request, { eligible: false, error: error?.message || 'Drop roll failed.' }, status);
  }
}

async function resolvePlayer(request: Request): Promise<any> {
  const sessionId = sessionIdentity.resolveSession(request.headers.get('cookie') || '');
  if (sessionId === null) return null;
  const session = await sessionStore.readSession(sessionId);
  if (session === null || session.playerId === null) return null;
  const player = await playerStore.readPlayer(session.playerId);
  return player?.provider === 'wallet' ? player : null;
}

function json(request: Request, body: any, status = 200): Response {
  return createJsonResponse(request, body, status);
}
