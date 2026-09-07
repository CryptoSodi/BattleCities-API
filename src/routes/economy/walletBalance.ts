declare const require: any;

import { createJsonResponse, createOptionsResponse, resolveSessionPlayer } from '../_helpers';

const shopPaymentService = require('../../services/shopPaymentService');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  if (player === null) {
    return createJsonResponse(request, { ok: false, statusText: 'NOT LOGGED IN' }, 401);
  }
  if (player.provider !== 'wallet' || !player.walletAddress) {
    return createJsonResponse(request, { ok: false, statusText: 'WALLET LOGIN REQUIRED' }, 403);
  }

  try {
    const balance = await shopPaymentService.getWalletBalances(
      player.walletAddress,
    );
    return createJsonResponse(request, { ok: true, ...balance });
  } catch {
    return createJsonResponse(
      request,
      { ok: false, statusText: 'WALLET BALANCE UNAVAILABLE' },
      503,
    );
  }
}
