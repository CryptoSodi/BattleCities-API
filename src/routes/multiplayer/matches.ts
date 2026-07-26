declare const require: any;

import { isMatchId } from '@battlecities/shared';
import {
  createJsonResponse,
  createOptionsResponse,
  resolveSessionPlayer,
} from '../_helpers';

const multiplayerStore = require('../../stores/multiplayerStore');
const nodeCrypto = require('crypto');
const signalStore = require('../../stores/webrtcSignalStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(
  request: Request,
  matchId: string | null = null,
): Promise<Response> {
  if (matchId === null) {
    return createJsonResponse(request, {
      items: await multiplayerStore.listOpenMatches(),
    });
  }
  if (!isMatchId(matchId)) {
    return createJsonResponse(request, { error: 'Invalid match ID' }, 400);
  }
  const match = await multiplayerStore.getMatch(matchId);
  return match === null
    ? createJsonResponse(request, { error: 'Match not found' }, 404)
    : createJsonResponse(request, { item: match });
}

export async function POST(
  request: Request,
  matchId: string,
  action: string,
): Promise<Response> {
  if (!isMatchId(matchId)) {
    return createJsonResponse(request, { ok: false, error: 'Invalid match ID' }, 400);
  }
  if (action === 'observe') {
    return observe(request, matchId);
  }

  const player = await resolveSessionPlayer(request);
  if (player === null) {
    return createJsonResponse(request, { ok: false, error: 'Not logged in' }, 401);
  }

  if (action === 'exit') {
    const result = await multiplayerStore.exitMatch(player, matchId);
    return createJsonResponse(request, result, result.ok ? 200 : 409);
  }
  if (action === 'reconnect') {
    const assignment = await multiplayerStore.reconnect(player, matchId);
    return assignment === null
      ? createJsonResponse(request, { ok: false, error: 'Active match not found' }, 404)
      : createJsonResponse(request, { ok: true, assignment });
  }
  if (action === 'started') {
    const match = await multiplayerStore.markStarted(player, matchId);
    return match === null
      ? createJsonResponse(request, { ok: false, error: 'Match membership not found' }, 404)
      : createJsonResponse(request, { ok: true, match });
  }
  if (action === 'score') {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return createJsonResponse(request, { ok: false, error: 'Invalid JSON' }, 400);
    }
    try {
      const result = await multiplayerStore.submitScore(player, matchId, body?.score);
      return result === null
        ? createJsonResponse(request, { ok: false, error: 'Match membership not found' }, 404)
        : createJsonResponse(request, { ok: true, result });
    } catch (error) {
      if ((error as any)?.code === 'MATCH_NOT_STARTED') {
        return createJsonResponse(
          request,
          { ok: false, error: (error as Error).message },
          409,
        );
      }
      throw error;
    }
  }

  return createJsonResponse(request, { ok: false, error: 'Unknown match action' }, 404);
}

async function observe(request: Request, matchId: string): Promise<Response> {
  const match = await multiplayerStore.getMatch(matchId);
  if (match === null || match.status === 'closed') {
    return createJsonResponse(request, { ok: false, error: 'Match not found' }, 404);
  }

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    // An observer ID is optional; the API creates one when omitted.
  }
  const observerId = signalStore.isValidObserverId(body?.observerId)
    ? body.observerId
    : `obs-${cryptoRandomId()}`;
  await signalStore.registerObserver(matchId, observerId);
  return createJsonResponse(
    request,
    { ok: true, match, observerId },
    201,
  );
}

function cryptoRandomId(): string {
  return nodeCrypto.randomBytes(12).toString('hex');
}
