import { isMatchId } from '../../../../shared/src';
import {
  createJsonResponse,
  createOptionsResponse,
} from '../_helpers';

const archiveStore = require('../../stores/matchArchiveStore');
const broadcasterService = require('../../services/broadcasterService');
const nodeCrypto = require('crypto');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(
  request: Request,
  matchId: string | null = null,
  action: string | null = null,
): Promise<Response> {
  if (!broadcasterService.isAuthorizedRequest(request) && !isAuthorizedObserverRead(request, matchId)) {
    return createJsonResponse(request, { ok: false, error: 'Forbidden' }, 403);
  }
  if (matchId === null) {
    const url = new URL(request.url);
    return createJsonResponse(request, {
      items: await archiveStore.listArchives({
        limit: url.searchParams.get('limit'),
        includeIncomplete: url.searchParams.get('includeIncomplete') === '1',
      }),
    });
  }
  if (!isMatchId(matchId)) {
    return createJsonResponse(request, { ok: false, error: 'Invalid match ID' }, 400);
  }
  if (action === 'frames') {
    const url = new URL(request.url);
    const result = await archiveStore.getArchiveFrames(matchId, {
      afterSeq: url.searchParams.get('afterSeq'),
      batchLimit: url.searchParams.get('batchLimit'),
    });
    return result === null
      ? createJsonResponse(request, { ok: false, error: 'Archive not found' }, 404)
      : createJsonResponse(request, { ok: true, ...result });
  }
  if (action !== null) {
    return createJsonResponse(request, { ok: false, error: 'Unknown archive action' }, 404);
  }
  const archive = await archiveStore.getArchive(matchId);
  return archive === null
    ? createJsonResponse(request, { ok: false, error: 'Archive not found' }, 404)
    : createJsonResponse(request, { ok: true, item: archive });
}

export async function POST(
  request: Request,
  matchId: string,
  action: string,
): Promise<Response> {
  if (!broadcasterService.isAuthorizedRequest(request)) {
    return createJsonResponse(request, { ok: false, error: 'Forbidden' }, 403);
  }
  if (!isMatchId(matchId)) {
    return createJsonResponse(request, { ok: false, error: 'Invalid match ID' }, 400);
  }
  let body: any;
  try {
    body = await request.json();
  } catch {
    return createJsonResponse(request, { ok: false, error: 'Invalid JSON' }, 400);
  }
  try {
    if (action === 'start') {
      const item = await archiveStore.startArchive(matchId, body);
      return createJsonResponse(request, { ok: true, item }, 201);
    }
    if (action === 'frames') {
      const item = await archiveStore.appendFrames(matchId, body?.frames);
      return createJsonResponse(request, { ok: true, item });
    }
    if (action === 'complete') {
      const item = await archiveStore.completeArchive(matchId, body);
      return createJsonResponse(request, { ok: true, item });
    }
    return createJsonResponse(request, { ok: false, error: 'Unknown archive action' }, 404);
  } catch (error) {
    const code = (error as any)?.code;
    const status =
      code === 'ARCHIVE_NOT_FOUND'
        ? 404
        : code === 'ARCHIVE_SEQUENCE_CONFLICT' || code === 'ARCHIVE_COMPLETED'
          ? 409
          : code === 'INVALID_ARCHIVE'
            ? 400
            : 500;
    if (status === 500) {
      throw error;
    }
    return createJsonResponse(
      request,
      { ok: false, error: (error as Error).message },
      status,
    );
  }
}

function isAuthorizedObserverRead(request: Request, matchId: string | null): boolean {
  if (matchId === null) {
    return false;
  }
  const secret = String(process.env.WEBSOCKET_TICKET_SECRET || '');
  if (secret.length < 32) {
    return false;
  }
  const payload = verifyObserverTicket(
    new URL(request.url).searchParams.get('ticket') || '',
    secret,
  );
  return (
    payload !== null &&
    payload.kind === 'observer' &&
    payload.matchId === matchId
  );
}

function verifyObserverTicket(
  ticket: string,
  secret: string,
): { matchId: string; kind: string; expiresAt: number } | null {
  const [payload, signature, extra] = ticket.split('.');
  if (!payload || !signature || extra !== undefined) {
    return null;
  }
  let decoded: any;
  try {
    decoded = JSON.parse(
      Buffer.from(fromBase64Url(payload), 'base64').toString('utf8'),
    );
  } catch {
    return null;
  }
  if (
    !decoded ||
    decoded.kind !== 'observer' ||
    typeof decoded.expiresAt !== 'number' ||
    decoded.expiresAt < Date.now()
  ) {
    return null;
  }
  const expected = nodeCrypto.createHmac('sha256', secret).update(payload).digest();
  const provided = Buffer.from(fromBase64Url(signature), 'base64');
  if (
    expected.length !== provided.length ||
    !nodeCrypto.timingSafeEqual(expected, provided)
  ) {
    return null;
  }
  return decoded;
}

function fromBase64Url(value: string): string {
  return value.replace(/-/g, '+').replace(/_/g, '/');
}
