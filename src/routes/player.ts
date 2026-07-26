declare const require: any;

import { createJsonResponse, createOptionsResponse } from './_helpers';

const playerStore = require('../stores/playerStore');
const sessionIdentity = require('../services/sessionIdentity');
const sessionStore = require('../stores/sessionStore');

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

  return json(request, {
    authenticated: true,
    player: playerStore.toPublicPlayer(player),
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

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json(request, { error: 'Invalid JSON' }, 400);
  }

  if (
    !isValidHighscore(body?.highscorePrimary) ||
    !isValidHighscore(body?.highscoreSecondary)
  ) {
    return json(request, { error: 'Invalid highscore' }, 400);
  }

  const player = await playerStore.mergeHighscores(
    session.playerId,
    body.highscorePrimary,
    body.highscoreSecondary,
  );
  if (player === null) {
    return json(request, { error: 'Player not found' }, 404);
  }

  return json(request, {
    authenticated: true,
    player: playerStore.toPublicPlayer(player),
  });
}

function isValidHighscore(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 999999999
  );
}

function json(request: Request, body: any, status = 200): Response {
  return createJsonResponse(request, body, status);
}
