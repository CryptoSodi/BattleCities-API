declare const require: any;

const googleAuth = require('../../../services/googleAuth');
const sessionIdentity = require('../../../services/sessionIdentity');
const sessionStore = require('../../../stores/sessionStore');

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (code === null || state === null) {
    return googleAuth.redirectResponse(
      googleAuth.createFrontendRedirect('/?authError=google'),
    );
  }

  try {
    const login = await googleAuth.completeLogin({ code, state });
    const session = await sessionStore.createGoogleSession(login.profile);
    return new Response(null, {
      status: 302,
      headers: {
        location: googleAuth.createFrontendRedirect(login.returnTo),
        'set-cookie': sessionIdentity.createSessionCookie(session.id),
      },
    });
  } catch {
    return googleAuth.redirectResponse(
      googleAuth.createFrontendRedirect('/?authError=google'),
    );
  }
}
