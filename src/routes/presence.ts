declare const require: any;

import {
  createJsonResponse,
  createOptionsResponse,
  resolveSessionPlayer,
} from './_helpers';

const presenceStore = require('../stores/presenceStore');
const presenceIdentity = require('../services/presenceIdentity');
const rateLimiter = require('../services/rateLimiter');
const siteSettingsStore = require('../stores/siteSettingsStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(request: Request): Promise<Response> {
  const response = createJsonResponse(request, {
    ...(await presenceStore.getCounts()),
    liveUsersEnabled: await siteSettingsStore.getLiveUsersEnabled(),
    updatedAt: new Date().toISOString(),
  });
  response.headers.set('cache-control', 'no-store');
  return response;
}

export async function POST(request: Request): Promise<Response> {
  const cookieHeader = request.headers.get('cookie') || '';
  const existingVisitorId = presenceIdentity.resolveVisitorId(cookieHeader);
  const rateLimitKey = existingVisitorId || getRequestAddress(request);
  if (!rateLimiter.allow('presence-heartbeat', rateLimitKey)) {
    return createJsonResponse(
      request,
      { ok: false, error: 'Too many requests' },
      429,
    );
  }

  const player = await resolveSessionPlayer(request);
  let body: any;
  try {
    body = await request.json();
  } catch {
    return createJsonResponse(request, { ok: false, error: 'Invalid JSON' }, 400);
  }

  const visitorId = existingVisitorId || presenceIdentity.createVisitorId();
  const clientId = normalizeClientId(body?.clientId);
  await presenceStore.recordPresence(visitorId, clientId, {
    playerId: player?.id,
    inGame: player !== null && body?.inGame === true,
    gameMode: body?.gameMode,
  });
  return createJsonResponse(
    request,
    {
      ok: true,
      ...(await presenceStore.getCounts()),
      liveUsersEnabled: await siteSettingsStore.getLiveUsersEnabled(),
    },
    200,
    existingVisitorId === null
      ? presenceIdentity.createPresenceCookie(
          visitorId,
          request.headers.get('origin'),
        )
      : null,
  );
}

export async function DELETE(request: Request): Promise<Response> {
  const visitorId = presenceIdentity.resolveVisitorId(
    request.headers.get('cookie') || '',
  );
  const clientId = normalizeClientId(
    new URL(request.url).searchParams.get('clientId'),
  );
  if (visitorId !== null) {
    await presenceStore.removePresence(visitorId, clientId);
  }
  return createJsonResponse(request, { ok: true });
}

function normalizeClientId(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9-]{6,80}$/i.test(value)
    ? value
    : 'legacy';
}

function getRequestAddress(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-real-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}
