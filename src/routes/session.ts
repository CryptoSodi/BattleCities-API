declare const require: any;

import { createJsonResponse, createOptionsResponse } from './_helpers';

const sessionIdentity = require('../services/sessionIdentity');
const sessionStore = require('../stores/sessionStore');
const walletAuth = require('../services/walletAuth');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(request: Request): Promise<Response> {
  const sessionId = sessionIdentity.resolveSession(
    request.headers.get('cookie') || '',
  );

  if (sessionId === null) {
    return json(request, { authenticated: false });
  }

  const session = await sessionStore.readSession(sessionId);
  if (session === null) {
    return json(
      request,
      { authenticated: false },
      200,
      sessionIdentity.createClearedSessionCookie(
        request.headers.get('origin'),
      ),
    );
  }

  return json(request, sessionStore.toPublicSession(session));
}

export async function POST(request: Request): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json(request, { error: 'Invalid JSON' }, 400);
  }

  if (body?.provider !== 'wallet') {
    return json(request, { error: 'Unsupported login provider' }, 400);
  }

  if (
    !(await walletAuth.verifyChallenge({
      walletAddress: body.walletAddress,
      nonce: body.nonce,
      message: body.message,
      signature: body.signature,
    }))
  ) {
    return json(request, { error: 'Invalid wallet signature' }, 401);
  }

  const session = await sessionStore.createWalletSession(body.walletAddress);

  return json(
    request,
    sessionStore.toPublicSession(session),
    201,
    sessionIdentity.createSessionCookie(
      session.id,
      request.headers.get('origin'),
    ),
  );
}

export async function PUT(request: Request): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json(request, { error: 'Invalid JSON' }, 400);
  }

  if (!walletAuth.isValidWalletAddress(body?.walletAddress)) {
    return json(request, { error: 'Invalid wallet address' }, 400);
  }

  const challenge = await walletAuth.createChallenge(body.walletAddress);

  return json(request, challenge, 201);
}

export async function DELETE(request: Request): Promise<Response> {
  const sessionId = sessionIdentity.resolveSession(
    request.headers.get('cookie') || '',
  );

  if (sessionId !== null) {
    await sessionStore.deleteSession(sessionId);
  }

  return json(
    request,
    { authenticated: false },
    200,
    sessionIdentity.createClearedSessionCookie(request.headers.get('origin')),
  );
}

function json(
  request: Request,
  body: any,
  status = 200,
  setCookie: string | null = null,
): Response {
  return createJsonResponse(request, body, status, setCookie);
}
