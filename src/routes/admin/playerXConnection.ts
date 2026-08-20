declare const require: any;

import { createJsonResponse, createOptionsResponse } from '../_helpers';
import { isResponse, requireAdmin } from './_helpers';

const xConnectionStore = require('../../stores/xConnectionStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function DELETE(request: Request, playerId: string): Promise<Response> {
  const authorization = await requireAdmin(request);
  if (isResponse(authorization)) return authorization;
  if (!/^ply-[a-z0-9-]+$/i.test(playerId)) {
    return createJsonResponse(request, { ok: false, error: 'Invalid player ID' }, 400);
  }

  const result = await xConnectionStore.unlinkAccount(playerId);
  return createJsonResponse(request, { ok: true, ...result });
}
