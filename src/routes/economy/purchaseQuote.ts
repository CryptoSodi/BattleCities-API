declare const require: any;

import { createJsonResponse, createOptionsResponse } from '../_helpers';

const playerStore = require('../../stores/playerStore');
const rateLimiter = require('../../services/rateLimiter');
const sessionIdentity = require('../../services/sessionIdentity');
const sessionStore = require('../../stores/sessionStore');
const shopPaymentService = require('../../services/shopPaymentService');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function POST(request: Request): Promise<Response> {
  const player = await resolvePlayer(request);
  if (player === null) {
    return json(request, { ok: false, statusText: 'NOT LOGGED IN' }, 401);
  }
  if (!rateLimiter.allow('shop-purchase-quote', player.id)) {
    return json(request, { ok: false, statusText: 'TOO MANY REQUESTS' }, 429);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json(request, { ok: false, statusText: 'INVALID JSON' }, 400);
  }

  try {
    const quote = await shopPaymentService.createQuote(player, body);
    return json(request, { ok: true, ...quote });
  } catch (error) {
    return json(request, {
      ok: false,
      statusText: error instanceof Error ? error.message : 'QUOTE FAILED',
    }, 400);
  }
}

async function resolvePlayer(request: Request): Promise<any | null> {
  const sessionId = sessionIdentity.resolveSession(request.headers.get('cookie') || '');
  if (sessionId === null) return null;
  const session = await sessionStore.readSession(sessionId);
  if (session === null || session.playerId === null) return null;
  return playerStore.readPlayer(session.playerId);
}

function json(request: Request, body: any, status = 200): Response {
  return createJsonResponse(request, body, status);
}
