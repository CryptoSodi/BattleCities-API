declare const require: any;

import { resolveSessionPlayer } from '../../../_helpers';

const sessionIdentity = require('../../../../services/sessionIdentity');
const rateLimiter = require('../../../../services/rateLimiter');
const xOAuth = require('../../../../services/xOAuth');

export async function GET(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  const sessionId = sessionIdentity.resolveSession(request.headers.get('cookie') || '');
  if (player === null || sessionId === null) {
    return xOAuth.redirectResponse(xOAuth.createFrontendRedirect('/?xError=login'));
  }
  if (!rateLimiter.allow('x-oauth-start', player.id)) {
    return xOAuth.redirectResponse(xOAuth.createFrontendRedirect('/?xError=rate'));
  }
  try {
    const requestedPurpose = new URL(request.url).searchParams.get('purpose');
    const purpose = requestedPurpose === 'repost'
      ? 'repost'
      : requestedPurpose === xOAuth.FOLLOW_VERIFICATION_PURPOSE
        ? xOAuth.FOLLOW_VERIFICATION_PURPOSE
        : xOAuth.CONNECTION_PURPOSE;
    return xOAuth.redirectResponse(
      xOAuth.createAuthorizationUrl(new URL(request.url).origin, player.id, sessionId, purpose),
    );
  } catch {
    return xOAuth.redirectResponse(xOAuth.createFrontendRedirect('/?xError=config'));
  }
}
