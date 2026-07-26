declare const require: any;

import {
  createJsonResponse,
  createOptionsResponse,
  resolveSessionPlayer,
} from '../_helpers';

const stakingStore = require('../../stores/stakingStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

// Epoch/day, community stats, the caller's stake/SP/estimated reward, unstake
// cooldown positions, and the perk tier table. Works logged-out (zeroed "me").
export async function GET(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  const summary = await stakingStore.getSummary(player === null ? null : player.id);

  return createJsonResponse(request, summary);
}
