declare const require: any;
import { createJsonResponse, createOptionsResponse, resolveSessionPlayer } from '../_helpers';
const recovery = require('../../services/shopRecovery');
const limiter = require('../../services/rateLimiter');
export function OPTIONS(request: Request): Response { return createOptionsResponse(request); }
export async function POST(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  if (!player) return createJsonResponse(request, { ok: false, statusText: 'NOT LOGGED IN' }, 401);
  if (player.provider !== 'wallet') return createJsonResponse(request, { ok: false, statusText: 'WALLET LOGIN REQUIRED' }, 403);
  if (!limiter.allow('shop-purchase-track', player.id)) return createJsonResponse(request, { ok: false, statusText: 'TOO MANY REQUESTS' }, 429);
  try { return createJsonResponse(request, await recovery.track(player, await request.json())); }
  catch (error: any) {
    const status = error?.code === 'DATABASE_REQUIRED' || error?.code === 'RECOVERY_UNAVAILABLE' ? 503 : 400;
    return createJsonResponse(request, { ok: false, statusText: status === 503 ? 'PAYMENT RECOVERY UNAVAILABLE' : (error?.message || 'INVALID PURCHASE') }, status);
  }
}
