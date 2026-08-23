declare const require: any;

import {
  createJsonResponse,
  createOptionsResponse,
  resolveSessionPlayer,
} from '../../_helpers';

const discordVerificationStore = require('../../../stores/discordVerificationStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function POST(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  if (player === null) {
    return createJsonResponse(request, { ok: false, error: 'Not logged in' }, 401);
  }
  const result = await discordVerificationStore.claimFollowReward(player);
  return createJsonResponse(request, result, result.ok ? 200 : 409);
}
