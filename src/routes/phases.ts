declare const require: any;

import { createJsonResponse, createOptionsResponse } from './_helpers';

const phaseStore = require('../stores/phaseStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

// Phase Rewards cards: long-running reward windows with status + pool.
export async function GET(request: Request): Promise<Response> {
  return createJsonResponse(request, { items: phaseStore.listPhases() });
}
