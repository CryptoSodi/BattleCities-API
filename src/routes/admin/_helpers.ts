import { createJsonResponse } from '../_helpers';
import { authorizeAdminRequest, AdminAuthorization } from '../../middleware/admin';

export type AuthorizedAdmin = Extract<AdminAuthorization, { ok: true }>;

export async function requireAdmin(
  request: Request,
): Promise<AuthorizedAdmin | Response> {
  const authorization = await authorizeAdminRequest(request);
  if (authorization.ok === false) {
    return createJsonResponse(
      request,
      {
        ok: false,
        error: authorization.status === 401 ? 'Authentication required' : 'Forbidden',
      },
      authorization.status,
    );
  }
  return authorization;
}

export function isResponse(value: AuthorizedAdmin | Response): value is Response {
  return value instanceof Response;
}

export function storeErrorResponse(request: Request, error: any): Response | null {
  const statusByCode: Record<string, number> = {
    DATABASE_REQUIRED: 503,
    DUPLICATE_SLUG: 409,
    INVALID_ALLOCATIONS: 400,
    INVALID_TOURNAMENT: 400,
    PAYOUT_LOCKED: 409,
    PLAYER_NOT_ELIGIBLE: 409,
    PRIZE_POOL_EXCEEDED: 409,
    TOURNAMENT_NOT_ENDED: 409,
  };
  const status = statusByCode[String(error?.code || '')];
  return status === undefined
    ? null
    : createJsonResponse(request, { ok: false, error: error.message }, status);
}
