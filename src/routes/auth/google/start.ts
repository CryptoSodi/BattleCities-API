declare const require: any;

const googleAuth = require('../../../services/googleAuth');

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const returnTo = googleAuth.normalizeFrontendPath(
    url.searchParams.get('returnTo'),
  );
  try {
    const origin = googleAuth.getOriginFromRequestUrl(request.url);
    return googleAuth.redirectResponse(
      googleAuth.createAuthorizationUrl(origin, returnTo),
    );
  } catch {
    return googleAuth.redirectResponse(
      googleAuth.createFrontendRedirect(
        `${returnTo}?authError=google_config`,
      ),
    );
  }
}
