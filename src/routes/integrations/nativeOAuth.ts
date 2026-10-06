declare const require: any;
import { createJsonResponse, createOptionsResponse, resolveSessionPlayer } from '../_helpers';
const nativeOAuth = require('../../services/nativeOAuth');
const store = require('../../stores/nativeOAuthStore');
const sessionIdentity = require('../../services/sessionIdentity');
const limiter = require('../../services/rateLimiter');
export function OPTIONS(request: Request): Response { return createOptionsResponse(request); }
export async function POST(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  if (!player) return createJsonResponse(request, { error: 'Authentication required' }, 401);
  if (player.provider !== 'wallet') return createJsonResponse(request, { error: 'Wallet login required' }, 403);
  if (!limiter.allow('native-oauth-start', player.id)) return createJsonResponse(request, { error: 'Too many requests' }, 429);
  try {
    const body = await request.json();
    const provider = new URL(request.url).pathname.includes('/x/') ? 'x' : 'discord';
    const session = sessionIdentity.resolveSession(request.headers.get('cookie') || '');
    return createJsonResponse(request, { ok: true, ...await nativeOAuth.start(provider, player, session, new URL(request.url).origin, body.returnUrl) });
  } catch (e: any) { return createJsonResponse(request, { error: e.message || 'Unable to start connection' }, 400); }
}
export async function GET(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  if (!player) return createJsonResponse(request, { error: 'Authentication required' }, 401);
  if (player.provider !== 'wallet') return createJsonResponse(request, { error: 'Wallet login required' }, 403);
  try {
    const item = await store.readStatus(new URL(request.url).searchParams.get('flowId'), player.id);
    return createJsonResponse(request, item ? { item } : { error: 'Connection not found' }, item ? 200 : 404);
  } catch { return createJsonResponse(request, { error: 'Invalid flow id' }, 400); }
}
