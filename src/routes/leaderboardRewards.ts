declare const require: any;

import { createJsonResponse, createOptionsResponse } from './_helpers';

const leaderboardRewards = require('../services/leaderboardRewards');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(request: Request): Promise<Response> {
  try {
    return createJsonResponse(request, await leaderboardRewards.getLiveBoard());
  } catch (error: any) {
    return createJsonResponse(
      request,
      { error: error?.message || 'Rewards leaderboard is unavailable.' },
      503,
    );
  }
}
