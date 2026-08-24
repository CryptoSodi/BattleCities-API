declare const require: any;

import {
  createJsonResponse,
  createOptionsResponse,
  resolveSessionPlayer,
} from '../_helpers';

const pushDeviceStore = require('../../stores/pushDeviceStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function POST(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  if (player === null) {
    return createJsonResponse(request, { error: 'Authentication required' }, 401);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return createJsonResponse(request, { error: 'Invalid JSON' }, 400);
  }

  if (!isValidToken(body?.token)) {
    return createJsonResponse(request, { error: 'Invalid notification token' }, 400);
  }

  const platform = body?.platform === 'android' ? 'android' : null;
  const permission = isPermission(body?.permission) ? body.permission : null;
  if (platform === null || permission === null) {
    return createJsonResponse(request, { error: 'Invalid notification device' }, 400);
  }

  await pushDeviceStore.upsertDevice(player.id, {
    token: body.token,
    platform,
    permission,
  });

  return createJsonResponse(request, { ok: true }, 201);
}

function isValidToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 20 && value.length <= 4096;
}

function isPermission(value: unknown): value is string {
  return value === 'granted' || value === 'denied' || value === 'prompted';
}
