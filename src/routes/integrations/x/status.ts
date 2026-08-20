declare const require: any;

import { createJsonResponse, createOptionsResponse, resolveSessionPlayer } from '../../_helpers';

const playerPolicy = require('../../../services/playerPolicy');
const rateLimiter = require('../../../services/rateLimiter');
const xConnectionStore = require('../../../stores/xConnectionStore');
const xOAuth = require('../../../services/xOAuth');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  if (player === null) return createJsonResponse(request, { authenticated: false }, 401);
  const account = await xConnectionStore.readLinkedAccount(player.id);
  if (account === null) return createJsonResponse(request, { authenticated: true, connected: false, follows: false });
  if (!rateLimiter.allow('x-follow-check', player.id)) {
    return createJsonResponse(request, { authenticated: true, ...(await xConnectionStore.readConnection(player.id)) });
  }
  try {
    const follows = await xOAuth.checkFollowsBattleCities(account.x_user_id || account.xUserId);
    const reward = await xConnectionStore.recordFollowCheckAndGrantReward(
      player,
      account.x_user_id || account.xUserId,
      follows,
    );
    const connection = await xConnectionStore.readConnection(player.id);
    return createJsonResponse(request, {
      authenticated: true,
      ...connection,
      followRewardGranted: reward.granted,
    });
  } catch (error) {
    console.warn('[battlecities-api] X follow check failed', error);
  }
  return createJsonResponse(request, { authenticated: true, ...(await xConnectionStore.readConnection(player.id)) });
}
