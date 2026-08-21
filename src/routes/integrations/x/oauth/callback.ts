declare const require: any;

const sessionIdentity = require('../../../../services/sessionIdentity');
const rateLimiter = require('../../../../services/rateLimiter');
const sessionStore = require('../../../../stores/sessionStore');
const xConnectionStore = require('../../../../stores/xConnectionStore');
const xOAuth = require('../../../../services/xOAuth');

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
