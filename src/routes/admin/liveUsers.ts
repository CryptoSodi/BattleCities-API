declare const require: any;

import { createJsonResponse, createOptionsResponse } from '../_helpers';
import { isResponse, requireAdmin } from './_helpers';

const siteSettingsStore = require('../../stores/siteSettingsStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(request: Request): Promise<Response> {
  const authorization = await requireAdmin(request);
  if (isResponse(authorization)) return authorization;
  return createJsonResponse(request, {
    ok: true,
    enabled: await siteSettingsStore.getLiveUsersEnabled(),
  });
}

export async function PATCH(request: Request): Promise<Response> {
  const authorization = await requireAdmin(request);
  if (isResponse(authorization)) return authorization;
  let body: any;
  try {
    body = await request.json();
  } catch {
    return createJsonResponse(request, { ok: false, error: 'Invalid JSON' }, 400);
  }
  if (typeof body?.enabled !== 'boolean') {
    return createJsonResponse(request, { ok: false, error: 'enabled must be a boolean' }, 400);
  }
  return createJsonResponse(request, {
    ok: true,
    enabled: await siteSettingsStore.setLiveUsersEnabled(body.enabled),
  });
}
