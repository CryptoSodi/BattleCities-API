declare const require: any;

const sessionIdentity = require('../../../../services/sessionIdentity');
const rateLimiter = require('../../../../services/rateLimiter');
const sessionStore = require('../../../../stores/sessionStore');
const xConnectionStore = require('../../../../stores/xConnectionStore');
const xOAuth = require('../../../../services/xOAuth');
const repostTasks = require('../../../../stores/xRepostTaskStore');

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const sessionId = sessionIdentity.resolveSession(request.headers.get('cookie') || '');
  if (code === null || state === null || sessionId === null) return redirectError('login');
  if (!rateLimiter.allow('x-oauth-callback', sessionId)) return redirectError('rate');
  try {
    const session = await sessionStore.readSession(sessionId);
    if (!session?.playerId) return redirectError('login');
    const completed = await xOAuth.completeConnection({ code, state, sessionId });
    if (completed.playerId !== session.playerId) return redirectError('state');
    if (completed.purpose === 'repost') {
      const linked = await xConnectionStore.readLinkedAccount(completed.playerId);
      const state = await xConnectionStore.readConnection(completed.playerId);
      const task = await repostTasks.activeForPlayer(completed.playerId);
      if (!linked || !state.follows || !task || String(linked.x_user_id || linked.xUserId) !== completed.profile.id) return redirectError('task');
      await xOAuth.repostWithUserToken(completed.accessToken, completed.profile.id, task.postId);
      const claim = await repostTasks.claim({ id: completed.playerId }, completed.profile.id, task.id);
      if (!claim.ok || !claim.granted) return redirectError('task');
      return xOAuth.redirectResponse(xOAuth.createFrontendRedirect('/?xRepostClaimed=1'));
    }
    if (completed.purpose === xOAuth.FOLLOW_VERIFICATION_PURPOSE) {
      if (!rateLimiter.allow('x-follow-check', completed.playerId)) return redirectError('rate');
      const linkedAccount = await xConnectionStore.readLinkedAccount(completed.playerId);
      if (linkedAccount === null || String(linkedAccount.x_user_id || linkedAccount.xUserId) !== completed.profile.id) {
        return redirectError('account');
      }
      const follows = await xOAuth.verifyFollowWithUserToken(completed.accessToken);
      await xConnectionStore.recordFollowCheckAndGrantReward(
        { id: completed.playerId },
        completed.profile.id,
        follows,
      );
      return xOAuth.redirectResponse(xOAuth.createFrontendRedirect('/?xFollowVerified=1'));
    }
    const result = await xConnectionStore.linkAccount(
      completed.playerId,
      completed.profile.id,
      completed.profile.username,
    );
    return result.ok
      ? xOAuth.redirectResponse(xOAuth.createFrontendRedirect('/?xConnected=1'))
      : redirectError('linked');
  } catch (error) {
    // The service deliberately sanitizes X errors and never includes tokens.
    console.warn('[battlecities-api] X OAuth callback failed', error);
    return redirectError('failed');
  }
}

function redirectError(reason: string): Response {
  return xOAuth.redirectResponse(
    xOAuth.createFrontendRedirect(`/?xError=${encodeURIComponent(reason)}`),
  );
}
