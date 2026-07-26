declare const require: any;

import {
  createJsonResponse,
  createOptionsResponse,
  resolveSessionPlayer,
} from './_helpers';
import {
  isMatchId,
  WebRtcSignalPublishRequest,
  WebRtcSignalPublishResponse,
  WebRtcSignalReadResponse,
} from '../../../shared/src';

const signalStore = require('../stores/webrtcSignalStore');
const multiplayerStore = require('../stores/multiplayerStore');
const broadcasterService = require('../services/broadcasterService');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function POST(
  request: Request,
  matchId: string,
  playerIndex: string,
  kind: string,
): Promise<Response> {
  if (!isValidRoute(matchId, playerIndex, kind)) {
    return createJsonResponse(request, { ok: false, error: 'Invalid signal route' }, 400);
  }
  if (!(await authorizeSignalRequest(request, matchId))) {
    return createJsonResponse(request, { ok: false, error: 'Forbidden' }, 403);
  }

  let body: WebRtcSignalPublishRequest;
  try {
    body = (await request.json()) as WebRtcSignalPublishRequest;
  } catch {
    return createJsonResponse(request, { ok: false, error: 'Invalid JSON' }, 400);
  }

  try {
    const result = await signalStore.publishSignal(
      matchId,
      playerIndex,
      kind,
      body?.code,
    );
    const response: WebRtcSignalPublishResponse = {
      ok: true,
      id: result.id,
      createdAt: result.createdAt,
    };
    return createJsonResponse(
      request,
      response,
      201,
    );
  } catch (error) {
    return createJsonResponse(
      request,
      { ok: false, error: (error as Error).message },
      400,
    );
  }
}

export async function GET(
  request: Request,
  matchId: string,
  playerIndex: string,
  kind: string,
): Promise<Response> {
  if (!isValidRoute(matchId, playerIndex, kind)) {
    return createJsonResponse(request, { ok: false, error: 'Invalid signal route' }, 400);
  }
  if (!(await authorizeSignalRequest(request, matchId))) {
    return createJsonResponse(request, { ok: false, error: 'Forbidden' }, 403);
  }

  const url = new URL(request.url);
  const signal = await signalStore.readSignal(
    matchId,
    playerIndex,
    kind,
    Number(url.searchParams.get('after') || '0'),
  );

  const response: WebRtcSignalReadResponse = { ok: true, signal };
  return createJsonResponse(request, response);
}

function isValidRoute(matchId: string, playerIndex: string, kind: string): boolean {
  return (
    isMatchId(matchId) &&
    signalStore.isValidPlayerIndex(playerIndex) &&
    signalStore.isValidSignalKind(kind)
  );
}

async function authorizeSignalRequest(
  request: Request,
  signalingMatchId: string,
): Promise<boolean> {
  if (broadcasterService.isAuthorizedRequest(request)) {
    return true;
  }

  const observerRoute = signalingMatchId.match(/^(match-[0-9a-z-]+)-o-([0-9a-z]{8})$/i);
  if (observerRoute !== null) {
    const observers = await signalStore.listObservers(observerRoute[1]);
    return observers.includes(observerRoute[2].toLowerCase());
  }

  const playerRoute = signalingMatchId.match(/^(match-[0-9a-z-]+)-p([12])$/i);
  if (playerRoute === null) {
    return false;
  }
  const player = await resolveSessionPlayer(request);
  if (player === null) {
    return false;
  }
  const authorization = String(request.headers.get('authorization') || '');
  const joinToken = authorization.startsWith('Bearer ')
    ? authorization.slice(7).trim()
    : '';
  return multiplayerStore.authorizePlayerJoin(
    player.id,
    playerRoute[1],
    Number(playerRoute[2]) - 1,
    joinToken,
  );
}
