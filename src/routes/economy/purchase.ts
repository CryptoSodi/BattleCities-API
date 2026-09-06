declare const require: any;

import { createJsonResponse, createOptionsResponse } from '../_helpers';

const database = require('../../database');
const economyStore = require('../../stores/economyStore');
const playerStore = require('../../stores/playerStore');
const sessionIdentity = require('../../services/sessionIdentity');
const sessionStore = require('../../stores/sessionStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function POST(request: Request): Promise<Response> {
  const sessionId = sessionIdentity.resolveSession(
    request.headers.get('cookie') || '',
  );

  if (sessionId === null) {
    return json(request, { ok: false, statusText: 'NOT LOGGED IN' }, 401);
  }

  const session = await sessionStore.readSession(sessionId);
  if (session === null || session.playerId === null) {
    return json(request, { ok: false, statusText: 'NOT LOGGED IN' }, 401);
  }

  const player = await playerStore.readPlayer(session.playerId);
  if (player === null) {
    return json(request, { ok: false, statusText: 'PLAYER NOT FOUND' }, 404);
  }
  if (player.provider !== 'google') {
    return json(request, { ok: false, statusText: 'USE WALLET PAYMENT' }, 403);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json(request, { ok: false, statusText: 'INVALID JSON' }, 400);
  }

  const result = await database.withTransaction(() =>
    economyStore.purchaseItemForPlayer(
      player,
      body?.itemId,
      body?.currency,
    ),
  );

  return json(request, result, result.ok ? 200 : 400);
}

function json(request: Request, body: any, status = 200): Response {
  return createJsonResponse(request, body, status);
}
