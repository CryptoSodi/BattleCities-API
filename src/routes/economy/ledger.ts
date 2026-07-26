declare const require: any;

import {
  createJsonResponse,
  createOptionsResponse,
  resolveSessionPlayer,
} from '../_helpers';

const ledgerStore = require('../../stores/ledgerStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

// The caller's recent ledger entries (purchases, quest rewards, stakes,
// claims) for the Treasury screen.
export async function GET(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  if (player === null) {
    return createJsonResponse(request, { authenticated: false }, 401);
  }

  const entries = await ledgerStore.listEntriesForPlayer(player.id, 20);
  return createJsonResponse(request, { authenticated: true, entries });
}
