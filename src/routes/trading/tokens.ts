declare const require: any;

import { createJsonResponse, createOptionsResponse } from '../_helpers';

const tradingStore = require('../../stores/tradingStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

// Configured tokens available to the shop and trading rankings.
export async function GET(request: Request): Promise<Response> {
  return createJsonResponse(request, {
    items: tradingStore.listTokens(),
    verifyMode: tradingStore.getVerifyMode(),
  });
}
