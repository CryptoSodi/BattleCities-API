declare const require: any;
import { createJsonResponse, createOptionsResponse } from './_helpers';
import { resolveSessionPlayer } from '../middleware/session';
const store = require('../stores/unityReplayStore');
const format = require('../services/unityReplayFormat');
const rate = require('../services/rateLimiter');
export const OPTIONS = createOptionsResponse;
export async function GET(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  if (!player) return createJsonResponse(request, { ok: false, error: 'Not logged in' }, 401);
  const id = new URL(request.url).searchParams.get('id');
  if (!store.isSessionId(id)) return createJsonResponse(request, { ok: false, error: 'Invalid replay session ID' }, 400);
  const session = await store.readSession(id, player.id);
  return session ? createJsonResponse(request, { ok: true, session, limits: format.LIMITS }) : createJsonResponse(request, { ok: false, error: 'Replay session not found' }, 404);
}
export async function POST(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  if (!player) return createJsonResponse(request, { ok: false, error: 'Not logged in' }, 401);
  if (!rate.allow('replay-session-create', player.id)) return createJsonResponse(request, { ok: false, error: 'Too many requests' }, 429);
  if (request.headers.get('origin') === 'https://magic.battlecities.com' && !require('../services/magicBlockPolicy').allowed(request))
    return createJsonResponse(request, { error: 'MagicBlock is unavailable.' }, 403);
  try {
    const session = await store.createSession(player.id, await format.readBoundedJson(request, 16384), request.headers.get('origin') === 'https://magic.battlecities.com');
    return createJsonResponse(request, { ok: true, session, limits: format.LIMITS }, 201);
  } catch (error) {
    if (error instanceof format.ReplayError) return createJsonResponse(request, { ok: false, error: error.message }, error.status);
    throw error;
  }
}
