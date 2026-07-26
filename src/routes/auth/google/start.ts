declare const require: any;

const googleAuth = require('../../../services/googleAuth');

export async function GET(request: Request): Promise<Response> {
  try {
    const origin = googleAuth.getOriginFromRequestUrl(request.url);
    return googleAuth.redirectResponse(googleAuth.createAuthorizationUrl(origin));
  } catch {
    return googleAuth.redirectResponse(
      googleAuth.createFrontendRedirect('/?authError=google_config'),
    );
  }
}
