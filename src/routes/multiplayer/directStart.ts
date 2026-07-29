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
const broadcasterService = require('../../services/broadcasterService');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function POST(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  if (player === null) {
    return createJsonResponse(request, { ok: false, error: 'Not logged in' }, 401);
  }

  try {
    const body = await readRequestBody(request);
    const tankTier = isMultiplayerTankTier(body?.tankTier)
      ? body.tankTier
      : 'a';
    const stage = Math.max(1, Math.floor(Number(body?.stage) || 1));
    const matchId = isMatchId(body?.matchId) ? body.matchId : null;
    const result = await multiplayerStore.startDirectMatch(
      player,
      getMultiplayerTankFuelCost(tankTier),
      tankTier,
      stage,
      matchId,
    );
    const abandonedMatchIds = Array.isArray(result.abandonedMatchIds)
      ? result.abandonedMatchIds
      : [];
    const { abandonedMatchIds: _ignored, ...assignment } = result;
    await Promise.all(
      abandonedMatchIds.map(async (matchId: string) => {
        try {
          await broadcasterService.stopMatch(matchId);
        } catch {
          // Matchmaking must continue even if an old runtime is already gone.
        }
      }),
    );
    if (assignment.match.status === 'waiting') {
      return createJsonResponse(request, { ok: true, assignment }, 201);
    }
    try {
      await broadcasterService.ensureMatchStarted(
        assignment.match.id,
        assignment.match.stage,
      );
      if (assignment.match.status === 'transition') {
        await broadcasterService.configureStagePlayer(
          assignment.match.id,
          assignment.playerSlot,
        );
      }
      return createJsonResponse(
        request,
        { ok: true, assignment, runtime: createPlayerRuntime(request, assignment) },
        201,
      );
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
  } catch (error) {
    return storeErrorResponse(request, error);
  }
}

async function readRequestBody(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function storeErrorResponse(request: Request, error: any): Response {
  if (error?.code === 'INSUFFICIENT_FUEL') {
    return createJsonResponse(request, { ok: false, error: error.message }, 409);
  }
  if (error?.code === 'STAGE_MATCH_UNAVAILABLE') {
    return createJsonResponse(request, { ok: false, error: error.message }, 409);
  }
  throw error;
}
