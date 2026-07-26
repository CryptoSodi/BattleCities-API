declare const require: any;

import { createJsonResponse, createOptionsResponse } from '../../_helpers';

const googleAuth = require('../../../services/googleAuth');
const sessionIdentity = require('../../../services/sessionIdentity');
const sessionStore = require('../../../stores/sessionStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function POST(request: Request): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json(request, { error: 'Invalid JSON' }, 400);
  }

  try {
    const profile = await googleAuth.completeNativeLogin(body?.idToken);
    const session = await sessionStore.createGoogleSession(profile);
    return json(
      request,
      sessionStore.toPublicSession(session),
      201,
      sessionIdentity.createSessionCookie(
        session.id,
        request.headers.get('origin'),
      ),
    );
  } catch {
    return json(request, { error: 'Invalid Google identity' }, 401);
  }
}

function json(
  request: Request,
  body: any,
  status = 200,
  setCookie: string | null = null,
): Response {
  return createJsonResponse(request, body, status, setCookie);
}
