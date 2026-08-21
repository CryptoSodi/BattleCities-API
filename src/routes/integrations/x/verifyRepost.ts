declare const require: any;

import { createJsonResponse, createOptionsResponse, resolveSessionPlayer } from '../../_helpers';

const xConnectionStore = require('../../../stores/xConnectionStore');
const repostTasks = require('../../../stores/xRepostTaskStore');
const twitterApi = require('../../../services/twitterApiIo');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function POST(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  if (player === null) return createJsonResponse(request, { authenticated: false }, 401);
  const account = await xConnectionStore.readLinkedAccount(player.id);
  const state = await xConnectionStore.readConnection(player.id);
  const task = await repostTasks.activeForPlayer(player.id);
  if (account === null || !state.follows || task === null) {
    return createJsonResponse(request, { ok: false, error: 'No eligible repost task.' }, 400);
  }
  try {
    const xUserId = String(account.x_user_id || account.xUserId || '');
    const reposted = await twitterApi.hasReposted(task.postId, xUserId);
    if (!reposted) return createJsonResponse(request, { ok: true, reposted: false });
    const claim = await repostTasks.claim(player, xUserId, task.id);
    return createJsonResponse(request, {
      ok: claim.ok,
      reposted: true,
      rewardGranted: claim.granted === true,
    });
  } catch (error) {
    console.warn('[battlecities-api] X repost verification failed', error);
    return createJsonResponse(request, { ok: false, error: 'Could not verify X repost.' }, 502);
  }
}
