declare const require: any;

import { createJsonResponse, createOptionsResponse } from './_helpers';

const { verifyCherryLaunchToken } = require('../services/cherryAuth');
const sessions = require('../stores/sessionStore');
const players = require('../stores/playerStore');
const rateLimiter = require('../services/rateLimiter');

export function OPTIONS(request: Request): Response { return createOptionsResponse(request); }

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get('origin');
  if (origin !== 'https://cherry.battlecities.com') return reply(request, { error: 'Cherry origin required' }, 403);
  if (!rateLimiter.allow('cherry-session', request.headers.get('x-forwarded-for') || 'local')) {
    return reply(request, { error: 'Too many requests' }, 429);
  }
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  if (!match) return reply(request, { error: 'Cherry launch token required' }, 401);

  let verified: any;
  try { verified = await verifyCherryLaunchToken(match[1]); }
  catch (error: any) {
    if (error?.code === 'JWKS_UNAVAILABLE') return reply(request, { error: 'Cherry sign-in is temporarily unavailable' }, 503);
    return reply(request, { error: 'Invalid or expired Cherry launch token' }, 401);
  }

  const session = await sessions.createCherrySession(verified.userKey, verified.wallet, verified.claims.user?.display_name);
  const player = await players.readPlayer(session.playerId);
  if (!player) throw new Error('Cherry player unavailable');
  return reply(request, {
    authenticated: true,
    sessionToken: session.id,
    player: { ...players.toPublicPlayer(player), walletAddress: session.walletAddress },
  }, 201);
}

function reply(request: Request, body: any, status: number): Response {
  const response = createJsonResponse(request, body, status);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
