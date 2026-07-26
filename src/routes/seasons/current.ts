declare const require: any;

import { createJsonResponse, createOptionsResponse } from '../_helpers';

const seasonStore = require('../../stores/seasonStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(request: Request): Promise<Response> {
  const season = await seasonStore.getCurrentSeason();

  return createJsonResponse(request, {
    season: seasonStore.toPublicSeason(season),
  });
}
