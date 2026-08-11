declare const require: any;

import { createJsonResponse, createOptionsResponse } from './_helpers';

const replayIdentity = require('../services/replayIdentity');
const replayStore = require('../stores/replayStore');
const sessionIdentity = require('../services/sessionIdentity');
const sessionStore = require('../stores/sessionStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(request: Request): Promise<Response> {
  const replayGuest = replayIdentity.resolveReplayGuest(
    request.headers.get('cookie') || '',
  );
  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  if (id !== null) {
    const record = await replayStore.readRecord(id, replayGuest.guestId);
    if (record === null) {
      return json(request, { error: 'Replay not found' }, 404, replayGuest.setCookie);
    }

    return json(request, { item: record }, 200, replayGuest.setCookie);
  }

  return json(
    request,
    { items: await replayStore.listSummaries(replayGuest.guestId) },
    200,
    replayGuest.setCookie,
  );
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

  if (!replayStore.isValidReplay(body?.replay)) {
    return json(
      request,
      { error: 'Invalid replay payload' },
      400,
      replayGuest.setCookie,
    );
  }

  const playerId = await resolveSignedInPlayer(request);

  const record = await replayStore.createRecord(
    replayGuest.guestId,
    body.replay,
    playerId,
  );

  return json(
    request,
    { item: replayStore.toSummary(record) },
    201,
    replayGuest.setCookie,
  );
}

async function resolveSignedInPlayer(request: Request): Promise<string | null> {
  const sessionId = sessionIdentity.resolveSession(
    request.headers.get('cookie') || '',
  );
  if (sessionId === null) {
    return null;
  }
  const session = await sessionStore.readSession(sessionId);
  if (session === null || session.playerId === null) {
    return null;
  }
  return session.playerId;
}

function json(
  request: Request,
  body: any,
  status = 200,
  setCookie: string | null = null,
): Response {
  return createJsonResponse(request, body, status, setCookie);
}
