import { isMatchId } from '../../../../shared/src';
import {
  createJsonResponse,
  createOptionsResponse,
} from '../_helpers';

const archiveStore = require('../../stores/matchArchiveStore');
const broadcasterService = require('../../services/broadcasterService');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(
  request: Request,
  matchId: string | null = null,
  action: string | null = null,
): Promise<Response> {
  if (!broadcasterService.isAuthorizedRequest(request)) {
    return createJsonResponse(request, { ok: false, error: 'Forbidden' }, 403);
  }
  if (matchId === null) {
    const url = new URL(request.url);
    return createJsonResponse(request, {
      items: await archiveStore.listArchives({
        limit: url.searchParams.get('limit'),
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
