declare const require: any;
import { createJsonResponse, createOptionsResponse, resolveSessionPlayer } from '../_helpers';
const shop = require('../../services/shopPaymentService');
const limiter = require('../../services/rateLimiter');
export function OPTIONS(request: Request): Response { return createOptionsResponse(request); }
export async function POST(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  if (!player) return createJsonResponse(request, { ok: false, statusText: 'NOT LOGGED IN' }, 401);
  if (player.provider !== 'wallet') return createJsonResponse(request, { ok: false, statusText: 'WALLET LOGIN REQUIRED' }, 403);
  if (!limiter.allow('shop-purchase-submit', player.id)) return createJsonResponse(request, { ok: false, statusText: 'TOO MANY REQUESTS' }, 429);
  try {
    const result = await shop.submitPurchase(player, await request.json());
    return createJsonResponse(request, result, result.pending ? 202 : 200);
  } catch (error: any) {
    return createJsonResponse(request, { ok: false, statusText: error.message || 'PAYMENT REJECTED' }, 400);
  }
}
