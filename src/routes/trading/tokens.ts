declare const require: any;

import { createJsonResponse, createOptionsResponse } from '../_helpers';

const tradingStore = require('../../stores/tradingStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

// Token-to-trait catalog: groups (native/stable/listed/unlisted rule) and the
// trait each listed token boosts.
export async function GET(request: Request): Promise<Response> {
  return createJsonResponse(request, {
    items: tradingStore.listTokens(),
    verifyMode: tradingStore.getVerifyMode(),
  });
}
