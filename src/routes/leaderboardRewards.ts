declare const require: any;

import { createJsonResponse, createOptionsResponse } from './_helpers';

const leaderboardRewards = require('../services/leaderboardRewards');
const sessionIdentity = require('../services/sessionIdentity');
const sessionStore = require('../stores/sessionStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(request: Request): Promise<Response> {
  try {
    const sessionId = sessionIdentity.resolveSession(request.headers.get('cookie') || '');
    const session = sessionId === null ? null : await sessionStore.readSession(sessionId);
    const response = createJsonResponse(request, await leaderboardRewards.getLiveBoard(session?.playerId || null));
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error: any) {
    return createJsonResponse(
      request,
      { error: error?.message || 'Rewards leaderboard is unavailable.' },
      503,
    );
  }
}
