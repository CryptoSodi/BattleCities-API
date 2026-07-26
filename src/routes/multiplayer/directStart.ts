declare const require: any;

import { DIRECT_MATCH_FUEL_COST } from '@battlecities/shared';
import {
  createJsonResponse,
  createOptionsResponse,
  resolveSessionPlayer,
} from '../_helpers';

const multiplayerStore = require('../../stores/multiplayerStore');

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
    return createJsonResponse(request, { ok: true, assignment }, 201);
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
