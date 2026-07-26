declare const require: any;

import { createJsonResponse, createOptionsResponse } from '../_helpers';

const replayIdentity = require('../../services/replayIdentity');
const replayStore = require('../../stores/replayStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function POST(request: Request): Promise<Response> {
  const replayGuest = replayIdentity.resolveReplayGuest(
    request.headers.get('cookie') || '',
  );

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json(request, { error: 'Invalid JSON' }, 400, replayGuest.setCookie);
  }

  const id = typeof body?.id === 'string' ? body.id : '';
  if (id === '') {
    return json(
      request,
      { error: 'Replay id is required' },
      400,
      replayGuest.setCookie,
    );
  }

  const record = await replayStore.verifyRecord(id, replayGuest.guestId);
  if (record === null) {
    return json(request, { error: 'Replay not found' }, 404, replayGuest.setCookie);
  }

  return json(
    request,
    { item: replayStore.toSummary(record) },
    200,
    replayGuest.setCookie,
  );
}

function json(
  request: Request,
  body: any,
  status = 200,
  setCookie: string | null = null,
): Response {
  return createJsonResponse(request, body, status, setCookie);
}
