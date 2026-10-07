declare const require: any;
import { createJsonResponse, createOptionsResponse } from '../_helpers';
import { resolveSessionPlayer } from '../../middleware/session';
const store = require('../../stores/unityReplayStore');
const format = require('../../services/unityReplayFormat');
const rate = require('../../services/rateLimiter');
export const OPTIONS = createOptionsResponse;
export async function GET(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  if (!player) return createJsonResponse(request, { ok: false, error: 'Not logged in' }, 401);
  if (!rate.allow('replay-read', player.id)) return createJsonResponse(request, { ok: false, error: 'Too many requests' }, 429);
  const id = new URL(request.url).searchParams.get('id');
  const statusOnly = new URL(request.url).pathname.endsWith('/status') || new URL(request.url).searchParams.get('__route') === 'replays/unity/status';
  if (id === null) {
    if (statusOnly) return createJsonResponse(request, { ok: false, error: 'Replay ID required' }, 400);
    try {
      const rawLimit = new URL(request.url).searchParams.get('limit');
      return createJsonResponse(request, { ok: true, items: await store.listSummaries(player.id, rawLimit === null ? 20 : Number(rawLimit)) });
    } catch (error) {
      if (error instanceof format.ReplayError) return createJsonResponse(request, { ok: false, error: error.message }, error.status);
      throw error;
    }
  }
  if (!store.isReplayId(id)) return createJsonResponse(request, { ok: false, error: 'Invalid replay ID' }, 400);
  const item = await store.readReplay(id, player.id);
  if (!item) return createJsonResponse(request, { ok: false, error: 'Replay not found' }, 404);
  return createJsonResponse(request, { ok: true, item: statusOnly ? store.toSummary(item) : item });
}
export async function POST(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  if (!player) return createJsonResponse(request, { ok: false, error: 'Not logged in' }, 401);
  if (!rate.allow('replay-submit', player.id)) return createJsonResponse(request, { ok: false, error: 'Too many requests' }, 429);
  try {
    const body = await format.readBoundedJson(request, format.LIMITS.maxBytes + 16384);
    if (!body || Array.isArray(body) || Object.keys(body).some((key) => !['sessionId', 'replay'].includes(key))) throw new format.ReplayError(400, 'Invalid replay submission fields');
    const result = await store.submitReplay(player.id, body.sessionId, body.replay);
    return createJsonResponse(request, { ok: true, ...result }, result.duplicate ? 200 : 201);
  } catch (error) {
    if (error instanceof format.ReplayError) return createJsonResponse(request, { ok: false, error: error.message }, error.status);
    throw error;
  }
}
