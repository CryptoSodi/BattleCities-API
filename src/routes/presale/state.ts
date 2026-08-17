declare const require: any;

import { createJsonResponse, createOptionsResponse } from '../_helpers';

const presaleService = require('../../services/presaleService');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(request: Request): Promise<Response> {
  const state = await presaleService.getState();
  const response = createJsonResponse(request, state);
  response.headers.set('cache-control', 'no-store');
  return response;
}
