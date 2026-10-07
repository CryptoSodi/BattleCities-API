declare const require: any;
import { createJsonResponse, createOptionsResponse } from '../_helpers';
import { isResponse, requireAdmin } from './_helpers';
const store = require('../../stores/unityReplayStore');
export const OPTIONS = createOptionsResponse;
export async function GET(request: Request): Promise<Response> {
  const authorization = await requireAdmin(request);
  if (isResponse(authorization)) return authorization;
  const id = new URL(request.url).searchParams.get('id');
  if (!store.isReplayId(id)) return createJsonResponse(request, { ok: false, error: 'Invalid replay ID' }, 400);
  const item = await store.readReplayAdmin(id);
  return item ? createJsonResponse(request, { ok: true, item }) : createJsonResponse(request, { ok: false, error: 'Replay not found' }, 404);
}
