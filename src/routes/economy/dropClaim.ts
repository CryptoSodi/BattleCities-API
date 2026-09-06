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
  if (player === null) return json(request, { delivered: false, error: 'Wallet login required.' }, 401);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json(request, { delivered: false, error: 'Invalid JSON.' }, 400);
  }
  if (typeof body?.claimId !== 'string' || !/^drop-[a-f0-9-]{36}$/.test(body.claimId)) {
    return json(request, { delivered: false, error: 'Invalid claim id.' }, 400);
  }

  try {
    const reward = await batcDrops.claim(player, body.claimId);
    return json(request, {
      delivered: reward.status === 'delivered',
      amount: reward.amount,
      signature: reward.deliverySignature,
    });
  } catch (error: any) {
    return json(request, {
      delivered: false,
      error: error?.message || 'BATC reward transfer failed.',
    }, 503);
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
