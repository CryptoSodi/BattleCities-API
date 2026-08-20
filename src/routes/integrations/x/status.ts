declare const require: any;

import { createJsonResponse, createOptionsResponse, resolveSessionPlayer } from '../../_helpers';

const xConnectionStore = require('../../../stores/xConnectionStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  if (player === null) return createJsonResponse(request, { authenticated: false }, 401);
  const account = await xConnectionStore.readLinkedAccount(player.id);
  if (account === null) return createJsonResponse(request, { authenticated: true, connected: false, follows: false });

  return createJsonResponse(request, { authenticated: true, ...(await xConnectionStore.readConnection(player.id)) });
}
