declare const require: any;

import { createJsonResponse, createOptionsResponse } from '../_helpers';

const database = require('../../database');
const playerPolicy = require('../../services/playerPolicy');
const eventStore = require('../../stores/eventStore');
const matchResultStore = require('../../stores/matchResultStore');
const playerStore = require('../../stores/playerStore');
const rateLimiter = require('../../services/rateLimiter');
const seasonStore = require('../../stores/seasonStore');
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
    return json(request, { ok: false, error: 'Not logged in' }, 401);
  }

  const session = await sessionStore.readSession(sessionId);
  if (session === null || session.playerId === null) {
    return json(request, { ok: false, error: 'Not logged in' }, 401);
  }

  const player = await playerStore.readPlayer(session.playerId);
  if (player === null) {
    return json(request, { ok: false, error: 'Player not found' }, 404);
  }

  if (!rateLimiter.allow('matches-submit', player.id)) {
    return json(request, { ok: false, error: 'Too many requests' }, 429);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json(request, { ok: false, error: 'Invalid JSON' }, 400);
  }

  const result = await database.withTransaction(async () => {
    const season = await seasonStore.getCurrentSeason();
    const submitted = await matchResultStore.submitResult(player, season, body);

    // Feed the SERVER-derived result into live event quests (Milestone 3).
    if (!playerPolicy.isVirtualPlayer(player)) {
      await eventStore.applyMatchResult(player, submitted);
    }
    return submitted;
  });

  return json(request, {
    ok: true,
    result: matchResultStore.toPublicResult(result),
  });
}

function json(request: Request, body: any, status = 200): Response {
  return createJsonResponse(request, body, status);
}
