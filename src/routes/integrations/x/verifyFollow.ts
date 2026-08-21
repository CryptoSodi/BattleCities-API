declare const require: any;

import { createJsonResponse, createOptionsResponse, resolveSessionPlayer } from '../../_helpers';

const xConnectionStore = require('../../../stores/xConnectionStore');
const twitterApi = require('../../../services/twitterApiIo');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function POST(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  if (player === null) return createJsonResponse(request, { authenticated: false }, 401);
  const account = await xConnectionStore.readLinkedAccount(player.id);
  if (account === null) return createJsonResponse(request, { ok: false, error: 'Connect X first.' }, 400);
  try {
    const follows = await twitterApi.checkFollowRelationship(account.x_username || account.xUsername);
    const reward = await xConnectionStore.recordFollowCheckAndGrantReward(
      player,
      account.x_user_id || account.xUserId,
      follows,
    );
    return createJsonResponse(request, { ok: true, follows, rewardGranted: reward.granted === true });
  } catch (error) {
    console.warn('[battlecities-api] X follow verification failed', error);
    return createJsonResponse(request, { ok: false, error: 'Could not verify X follow status.' }, 502);
  }
}
