declare const require: any;

import { createJsonResponse, createOptionsResponse } from '../_helpers';

const stakingStore = require('../../stores/stakingStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(request: Request): Promise<Response> {
  return createJsonResponse(request, {
    rows: await stakingStore.getLeaderboard(20),
  });
}
