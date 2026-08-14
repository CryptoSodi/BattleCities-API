declare const require: any;

import {
  createJsonResponse,
  createOptionsResponse,
  resolveSessionPlayer,
} from './_helpers';

const cherryEmbedToken = require('../services/cherryEmbedToken');
const rateLimiter = require('../services/rateLimiter');
const walletAuth = require('../services/walletAuth');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function POST(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  if (player === null) {
    return json(request, { error: 'Not logged in' }, 401);
  }

  if (!rateLimiter.allow('cherry-embed-token', player.id)) {
    return json(request, { error: 'Too many requests' }, 429);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json(request, { error: 'Invalid JSON' }, 400);
  }

  if (
    player.provider !== 'wallet' ||
    !walletAuth.isValidWalletAddress(player.walletAddress)
  ) {
    return json(request, { error: 'Wallet login required' }, 403);
  }

  if (
    !walletAuth.isValidWalletAddress(body?.walletAddress) ||
    body.walletAddress !== player.walletAddress
  ) {
    return json(request, { error: 'Wallet does not match session' }, 403);
  }

  if (!cherryEmbedToken.isConfigured()) {
    return json(request, { error: 'Chat authentication is unavailable' }, 503);
  }

  return json(request, {
    token: cherryEmbedToken.mintToken(player.walletAddress),
  });
}

function json(request: Request, body: any, status = 200): Response {
  const response = createJsonResponse(request, body, status);
  response.headers.set('cache-control', 'no-store');
  return response;
}
