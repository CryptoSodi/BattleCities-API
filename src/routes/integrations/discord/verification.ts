declare const require: any;

import {
  createJsonResponse,
  createOptionsResponse,
  resolveSessionPlayer,
} from '../../_helpers';

const discordVerificationStore = require('../../../stores/discordVerificationStore');
const playerPolicy = require('../../../services/playerPolicy');
const rateLimiter = require('../../../services/rateLimiter');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  if (player === null) {
    return createJsonResponse(request, { authenticated: false }, 401);
  }

  return createJsonResponse(request, {
    authenticated: true,
    ...(await discordVerificationStore.readVerification(player.id)),
  });
}

export async function POST(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  if (player === null) {
    return createJsonResponse(request, { ok: false, error: 'Not logged in' }, 401);
  }
  if (playerPolicy.isVirtualPlayer(player)) {
    return createJsonResponse(
      request,
      { ok: false, error: playerPolicy.VIRTUAL_PLAYER_MESSAGE },
      403,
    );
  }
  if (!rateLimiter.allow('discord-verification-code', player.id)) {
    return createJsonResponse(
      request,
      { ok: false, error: 'Too many verification codes requested' },
      429,
    );
  }

  const result = await discordVerificationStore.createVerificationCode(player.id);
  return createJsonResponse(request, result, result.ok ? 201 : 409);
}
