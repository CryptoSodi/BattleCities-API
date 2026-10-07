declare const require: any;

import { createJsonResponse, createOptionsResponse } from '../_helpers';

const database = require('../../database');
const matchResultStore = require('../../stores/matchResultStore');
const playerStore = require('../../stores/playerStore');
const rateLimiter = require('../../services/rateLimiter');
const seasonStore = require('../../stores/seasonStore');
const sessionIdentity = require('../../services/sessionIdentity');
const sessionStore = require('../../stores/sessionStore');
const unityReplayStore = require('../../stores/unityReplayStore');
const replayStore = require('../../stores/replayStore');
const replayFormat = require('../../services/unityReplayFormat');

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

  if (body?.mode && body.mode !== 'single') {
    return json(request, { ok: false, error: 'Only single-player matches are supported' }, 400);
  }

  try {
    const result = await database.withTransaction(async () => {
      const season = await seasonStore.getCurrentSeason();
      if (typeof body?.replayId === 'string' && /^urp-/i.test(body.replayId)) {
        return unityReplayStore.submitBoundMatch(player, season, body);
      }
      if (body?.replayId != null) {
        const replay = await replayStore.readRecordAdmin(body.replayId);
        if (!replay || replay.playerId !== player.id) throw new replayFormat.ReplayError(404, 'Owned replay not found');
      }
      const submitted = await matchResultStore.submitResult(player, season, body);

      return submitted;
    });

    return json(request, {
      ok: true,
      result: matchResultStore.toPublicResult(result),
    });
  } catch (error) {
    if (error instanceof replayFormat.ReplayError) return json(request, { ok: false, error: error.message }, error.status);
    throw error;
  }
}

function json(request: Request, body: any, status = 200): Response {
  return createJsonResponse(request, body, status);
}
