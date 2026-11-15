declare const require: any;
import { createJsonResponse, createOptionsResponse } from './_helpers';
import { resolveSessionPlayer } from '../middleware/session';
const policy = require('../services/magicBlockPolicy');
const service = require('../services/magicBlockDrops');
const rate = require('../services/rateLimiter');
const format = require('../services/unityReplayFormat');
export const OPTIONS = createOptionsResponse;
export async function POST(request: Request): Promise<Response> {
  const json = (body: any, code = 200) => createJsonResponse(request, body, code);
  if (!policy.allowed(request)) return json({ error: 'MagicBlock is unavailable for this origin or environment.' }, 403);
  const player = await resolveSessionPlayer(request);
  if (!player) return json({ error: 'Authentication required.' }, 401);
  const session = new URL(request.url).pathname.endsWith('/session');
  if (!rate.allow(session ? 'magic-session' : 'magic-drop', player.id)) return json({ error: 'Rate limit exceeded.' }, 429);
  try {
    const body = await format.readBoundedJson(request, 4096);
    if (session) return json(service.createSession(player.id, body), 201);
    return json(await service.drop(player.id, body));
  } catch (error: any) {
    return json({ error: error.status && error.status < 500 ? error.message : 'MagicBlock unavailable; no fallback drop was issued.' }, error.status || 503);
  }
}
