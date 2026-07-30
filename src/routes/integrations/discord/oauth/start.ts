declare const require: any;

import { resolveSessionPlayer } from '../../../_helpers';

const discordOAuth = require('../../../../services/discordOAuth');
const sessionIdentity = require('../../../../services/sessionIdentity');

export async function GET(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  const sessionId = sessionIdentity.resolveSession(
    request.headers.get('cookie') || '',
  );
  if (player === null || sessionId === null) {
    return discordOAuth.redirectResponse(
      discordOAuth.createFrontendRedirect('/?discordError=login'),
    );
  }

  try {
    const origin = new URL(request.url).origin;
    return discordOAuth.redirectResponse(
      discordOAuth.createAuthorizationUrl(origin, player.id, sessionId),
    );
  } catch {
    return discordOAuth.redirectResponse(
      discordOAuth.createFrontendRedirect('/?discordError=config'),
    );
  }
}
