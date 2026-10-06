declare const require: any;
import { createJsonResponse, createOptionsResponse, resolveSessionPlayer } from '../_helpers';
const swaps = require('../../services/skrSwap');
const limiter = require('../../services/rateLimiter');
export function OPTIONS(request: Request): Response { return createOptionsResponse(request); }
export async function POST(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  if (!player) return createJsonResponse(request, { error: 'Authentication required' }, 401);
  if (player.provider !== 'wallet') return createJsonResponse(request, { error: 'Wallet login required' }, 403);
  const execute = new URL(request.url).pathname.endsWith('/execute');
  if (!limiter.allow(execute ? 'skr-swap-execute' : 'skr-swap-quote', player.id)) return createJsonResponse(request, { error: 'Too many requests' }, 429);
  try {
    const body = await request.json();
    const result = execute ? await swaps.execute(player, body) : { ok: true, ...await swaps.quote(player, body) };
    return createJsonResponse(request, result);
  } catch (error: any) { return createJsonResponse(request, { ok: false, error: error.message || 'Swap unavailable' }, 400); }
}
