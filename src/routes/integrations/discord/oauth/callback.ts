declare const require: any;

const discordOAuth = require('../../../../services/discordOAuth');
const discordVerificationStore = require('../../../../stores/discordVerificationStore');
const sessionIdentity = require('../../../../services/sessionIdentity');
const sessionStore = require('../../../../stores/sessionStore');

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const sessionId = sessionIdentity.resolveSession(
    request.headers.get('cookie') || '',
  );
  if (code === null || state === null || sessionId === null) {
    return redirectError('login');
  }

  try {
    const session = await sessionStore.readSession(sessionId);
    if (session?.playerId === null || session?.playerId === undefined) {
      return redirectError('login');
    }

    const completed = await discordOAuth.completeVerification({
      code,
      state,
      sessionId,
    });
    if (completed.playerId !== session.playerId) {
      return redirectError('state');
    }

    const result = await discordVerificationStore.verifyDiscordAccount(
      completed.playerId,
      completed.profile.id,
      completed.profile.global_name || completed.profile.username,
    );
    return result.ok
      ? discordOAuth.redirectResponse(
          discordOAuth.createFrontendRedirect('/?discordVerified=1'),
        )
      : redirectError('linked');
  } catch (error) {
    const message = String(error?.message || '');
    return redirectError(
      message.includes('Join the Battle Cities') ? 'guild' : 'failed',
    );
  }
}

function redirectError(reason: string): Response {
  return discordOAuth.redirectResponse(
    discordOAuth.createFrontendRedirect(
      `/?discordError=${encodeURIComponent(reason)}`,
    ),
  );
}
