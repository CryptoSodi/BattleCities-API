import { createJsonResponse, createOptionsResponse } from '../_helpers';
import { authorizeAdminRequest } from '../../middleware/admin';

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(request: Request): Promise<Response> {
  const authorization = await authorizeAdminRequest(request);
  if (authorization.ok === false) {
    return createJsonResponse(
      request,
      { ok: false, authenticated: false, forbidden: authorization.status === 403 },
      authorization.status,
    );
  }
  return createJsonResponse(request, {
    ok: true,
    authenticated: true,
    admin: {
      playerId: authorization.player.id,
      email: authorization.email,
      name: authorization.session.googleName || authorization.player.displayName,
      picture: authorization.session.googlePicture || null,
    },
  });
}
