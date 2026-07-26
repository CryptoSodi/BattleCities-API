declare const require: any;

import { DIRECT_MATCH_FUEL_COST } from '../../../../shared/src';
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
    const assignment = await multiplayerStore.startDirectMatch(
      player,
      DIRECT_MATCH_FUEL_COST,
    );
    if (assignment.match.status === 'waiting') {
      return createJsonResponse(request, { ok: true, assignment }, 201);
    }
    try {
      await broadcasterService.ensureMatchStarted(assignment.match.id, 1);
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

function storeErrorResponse(request: Request, error: any): Response {
  if (error?.code === 'INSUFFICIENT_FUEL') {
    return createJsonResponse(request, { ok: false, error: error.message }, 409);
  }
  throw error;
}
