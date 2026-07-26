declare const require: any;

import { createJsonResponse, createOptionsResponse } from '../_helpers';

const economyStore = require('../../stores/economyStore');
const playerStore = require('../../stores/playerStore');
const sessionIdentity = require('../../services/sessionIdentity');
const sessionStore = require('../../stores/sessionStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(request: Request): Promise<Response> {
  const sessionId = sessionIdentity.resolveSession(
    request.headers.get('cookie') || '',
  );

  if (sessionId === null) {
    return json(request, { authenticated: false });
  }

  const session = await sessionStore.readSession(sessionId);
  if (session === null || session.playerId === null) {
    return json(request, { authenticated: false });
  }

  const player = await playerStore.readPlayer(session.playerId);
  if (player === null) {
    return json(request, { authenticated: false });
  }

  const account = await economyStore.ensureAccountForPlayer(player);

  return json(request, {
    authenticated: true,
    player: playerStore.toPublicPlayer(player),
    account: economyStore.toPublicAccount(account),
  });
}

export async function PUT(request: Request): Promise<Response> {
  const sessionId = sessionIdentity.resolveSession(
    request.headers.get('cookie') || '',
  );

  if (sessionId === null) {
    return json(request, { authenticated: false }, 401);
  }

  const session = await sessionStore.readSession(sessionId);
  if (session === null || session.playerId === null) {
    return json(request, { authenticated: false }, 401);
  }

  const player = await playerStore.readPlayer(session.playerId);
  if (player === null) {
    return json(request, { authenticated: false }, 401);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json(request, { error: 'Invalid JSON' }, 400);
  }

  let account;
  try {
    account = await economyStore.upsertAccountForPlayer(
      player,
      body?.account || body,
    );
  } catch (error) {
    return json(request, { error: 'Invalid account snapshot' }, 400);
  }

  return json(request, {
    authenticated: true,
    player: playerStore.toPublicPlayer(player),
    account: economyStore.toPublicAccount(account),
  });
}

function json(request: Request, body: any, status = 200): Response {
  return createJsonResponse(request, body, status);
}
