declare const require: any;

import {
  getMultiplayerTankFuelCost,
  isMatchId,
  isMultiplayerTankTier,
} from '../../../../shared/src';
import {
  createJsonResponse,
  createOptionsResponse,
  resolveSessionPlayer,
} from '../_helpers';
import { createPlayerRuntime } from './_runtime';

const multiplayerStore = require('../../stores/multiplayerStore');
const nodeCrypto = require('crypto');
const signalStore = require('../../stores/webrtcSignalStore');
const broadcasterService = require('../../services/broadcasterService');

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
  if (action === 'result') {
    return submitAuthoritativeResult(request, matchId);
  }
  if (action === 'stage') {
    return transitionStage(request, matchId);
  }
  if (action === 'stage-started') {
    return markStageStarted(request, matchId);
  }

  const player = await resolveSessionPlayer(request);
  if (player === null) {
    return createJsonResponse(request, { ok: false, error: 'Not logged in' }, 401);
  }

  if (action === 'exit') {
    const result = await multiplayerStore.exitMatch(player, matchId);
    return createJsonResponse(request, result, result.ok ? 200 : 409);
  }
  if (action === 'stage-rejoin') {
    return rejoinStage(request, matchId, player);
  }
  if (action === 'reconnect') {
    const assignment = await multiplayerStore.reconnect(player, matchId);
    if (assignment === null) {
      return createJsonResponse(request, { ok: false, error: 'Active match not found' }, 404);
    }
    if (assignment.match.status === 'waiting') {
      return createJsonResponse(request, { ok: true, assignment });
    }
    try {
      await broadcasterService.ensureMatchStarted(
        matchId,
        assignment.match.stage,
      );
      return createJsonResponse(request, {
        ok: true,
        assignment,
        runtime: createPlayerRuntime(request, assignment),
      });
    } catch (error) {
      if ((error as any)?.code?.startsWith('BROADCASTER_')) {
        return createJsonResponse(
          request,
          { ok: false, assignment, error: (error as Error).message },
          503,
        );
      }
      throw error;
    }
  }
  if (action === 'started') {
    const match = await multiplayerStore.markStarted(player, matchId);
    return match === null
      ? createJsonResponse(request, { ok: false, error: 'Match membership not found' }, 404)
      : createJsonResponse(request, { ok: true, match });
  }
  if (action === 'score') {
    return createJsonResponse(
      request,
      { ok: false, error: 'Only the broadcaster may submit match results' },
      403,
    );
  }
  return createJsonResponse(request, { ok: false, error: 'Unknown match action' }, 404);
}

async function rejoinStage(
  request: Request,
  matchId: string,
  player: any,
): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return createJsonResponse(request, { ok: false, error: 'Invalid JSON' }, 400);
  }
  const tankTier = isMultiplayerTankTier(body?.tankTier)
    ? body.tankTier
    : 'a';
  const stage = Math.max(1, Math.floor(Number(body?.stage) || 1));
  try {
    const assignment = await multiplayerStore.rejoinStagePlayer(
      player,
      matchId,
      stage,
      getMultiplayerTankFuelCost(tankTier),
      tankTier,
    );
    if (assignment === null) {
      return createJsonResponse(
        request,
        { ok: false, error: 'This player slot is not open for stage rejoin' },
        409,
      );
    }
    try {
      await broadcasterService.configureStagePlayer(
        matchId,
        assignment.playerSlot,
      );
    } catch (error) {
      console.error(
        `[multiplayer] stage player configuration failed for ${matchId}`,
        error,
      );
      return createJsonResponse(
        request,
        {
          ok: false,
          assignment,
          error: 'Broadcaster is unavailable; stage rejoin can be retried',
        },
        503,
      );
    }
    return createJsonResponse(request, { ok: true, assignment });
  } catch (error) {
    if ((error as any)?.code === 'INSUFFICIENT_FUEL') {
      return createJsonResponse(
        request,
        { ok: false, error: (error as Error).message },
        409,
      );
    }
    throw error;
  }
}

async function transitionStage(
  request: Request,
  matchId: string,
): Promise<Response> {
  if (!broadcasterService.isAuthorizedRequest(request)) {
    return createJsonResponse(request, { ok: false, error: 'Forbidden' }, 403);
  }
  let body: any;
  try {
    body = await request.json();
  } catch {
    return createJsonResponse(request, { ok: false, error: 'Invalid JSON' }, 400);
  }
  try {
    const match = await multiplayerStore.transitionMatchStage(
      matchId,
      body?.stageNumber,
      body?.openSlots,
      body?.scores,
    );
    return match === null
      ? createJsonResponse(request, { ok: false, error: 'Match not found' }, 404)
      : createJsonResponse(request, { ok: true, match });
  } catch (error) {
    if ((error as any)?.code === 'INVALID_STAGE_TRANSITION') {
      return createJsonResponse(
        request,
        { ok: false, error: (error as Error).message },
        409,
      );
    }
    throw error;
  }
}

async function markStageStarted(
  request: Request,
  matchId: string,
): Promise<Response> {
  if (!broadcasterService.isAuthorizedRequest(request)) {
    return createJsonResponse(request, { ok: false, error: 'Forbidden' }, 403);
  }
  let body: any;
  try {
    body = await request.json();
  } catch {
    return createJsonResponse(request, { ok: false, error: 'Invalid JSON' }, 400);
  }
  const match = await multiplayerStore.markMatchStageStarted(
    matchId,
    body?.stageNumber,
  );
  return match === null
    ? createJsonResponse(request, { ok: false, error: 'Match not found' }, 404)
    : createJsonResponse(request, { ok: true, match });
}

async function submitAuthoritativeResult(
  request: Request,
  matchId: string,
): Promise<Response> {
  if (!broadcasterService.isAuthorizedRequest(request)) {
    return createJsonResponse(request, { ok: false, error: 'Forbidden' }, 403);
  }
  let body: any;
  try {
    body = await request.json();
  } catch {
    return createJsonResponse(request, { ok: false, error: 'Invalid JSON' }, 400);
  }
  try {
    const match = await multiplayerStore.completeAuthoritativeMatch(
      matchId,
      body?.scores,
    );
    if (match === null) {
      return createJsonResponse(request, { ok: false, error: 'Match not found' }, 404);
    }
    await broadcasterService.stopMatch(matchId);
    return createJsonResponse(request, { ok: true, match });
  } catch (error) {
    if ((error as any)?.code === 'INVALID_RESULT') {
      return createJsonResponse(
        request,
        { ok: false, error: (error as Error).message },
        400,
      );
    }
    throw error;
  }
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
    : cryptoRandomId();
  await signalStore.registerObserver(matchId, observerId);
  return createJsonResponse(
    request,
    { ok: true, match, observerId },
    201,
  );
}

function cryptoRandomId(): string {
  return nodeCrypto.randomBytes(4).toString('hex');
}
