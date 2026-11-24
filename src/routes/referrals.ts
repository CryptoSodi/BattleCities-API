declare const require: any;
import { createJsonResponse, createOptionsResponse } from './_helpers';
const players = require('../stores/playerStore');
const sessions = require('../stores/sessionStore');
const identity = require('../services/sessionIdentity');
const referrals = require('../stores/referralStore');
const limiter = require('../services/rateLimiter');

export function OPTIONS(request: Request): Response { return createOptionsResponse(request); }
async function currentPlayer(request: Request): Promise<any> {
  const id = identity.resolveSession(request.headers.get('cookie') || '');
  if (!id) return null;
  const session = await sessions.readSession(id);
  if (!session?.playerId) return null;
  const player = await players.readPlayerForSession(session);
  return player?.provider === 'wallet' ? player : null;
}
export async function GET(request: Request): Promise<Response> {
  const player = await currentPlayer(request);
  if (!player) return createJsonResponse(request, { ok: false, statusText: 'SIGN IN TO USE REFERRALS' }, 401);
  const referral = await referrals.ensureProfile(player);
  return createJsonResponse(request, { ok: true, referral });
}
export async function POST(request: Request): Promise<Response> {
  const player = await currentPlayer(request);
  if (!player) return createJsonResponse(request, { ok: false, statusText: 'SIGN IN TO USE REFERRALS' }, 401);
  if (!limiter.allow('referrals', player.id)) return createJsonResponse(request, { ok: false, statusText: 'TOO MANY REQUESTS' }, 429);
  let body: any;
  try { body = await request.json(); } catch { return createJsonResponse(request, { ok: false, statusText: 'INVALID REQUEST' }, 400); }
  if (body?.expectedPlayerId !== player.id) return createJsonResponse(request, { ok: false, statusText: 'PLAYER SESSION CHANGED' }, 409);
  try {
    if (body.action === 'dismiss') await referrals.dismissPrompt(player);
    else if (body.action === 'apply') await referrals.applyCode(player, body.code);
    else return createJsonResponse(request, { ok: false, statusText: 'INVALID ACTION' }, 400);
    return createJsonResponse(request, { ok: true, referral: await referrals.ensureProfile(player) });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const expected = ['Enter a valid referral link or code.', 'Enter a Battle Cities referral link.',
      'Referral code was not found.', 'You cannot use your own referral code.',
      'A referral has already been applied to this account.'];
    if (expected.includes(message)) return createJsonResponse(request, { ok: false, statusText: message }, 400);
    return createJsonResponse(request, { ok: false, statusText: 'REFERRALS ARE UNAVAILABLE. PLEASE TRY AGAIN.' }, 503);
  }
}
