declare const require: any;

import {
  createJsonResponse,
  createOptionsResponse,
  resolveSessionPlayer,
} from './_helpers';

const presenceStore = require('../stores/presenceStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(request: Request): Promise<Response> {
  const response = createJsonResponse(request, {
    ...(await presenceStore.getCounts()),
    updatedAt: new Date().toISOString(),
  });
  response.headers.set('cache-control', 'no-store');
  return response;
}

export async function POST(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  if (player === null) {
    return createJsonResponse(request, { ok: false, error: 'Not logged in' }, 401);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return createJsonResponse(request, { ok: false, error: 'Invalid JSON' }, 400);
  }

  await presenceStore.recordPresence(player.id, {
    inGame: body?.inGame === true,
    gameMode: body?.gameMode,
  });
  return createJsonResponse(request, { ok: true });
}

export async function DELETE(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  if (player !== null) {
    await presenceStore.removePresence(player.id);
  }
  return createJsonResponse(request, { ok: true });
}
