declare const require: any;
import { createJsonResponse, createOptionsResponse } from '../_helpers';
import { isResponse, requireAdmin, storeErrorResponse } from './_helpers';
const attempts = require('../../stores/shopAttemptStore');
export function OPTIONS(request: Request): Response { return createOptionsResponse(request); }
export async function GET(request: Request): Promise<Response> {
  const authorization = await requireAdmin(request);
  if (isResponse(authorization)) return authorization;
  const params = new URL(request.url).searchParams;
  try {
    return createJsonResponse(request, { ok: true, ...await attempts.listPending({ limit: params.get('limit'), offset: params.get('offset') }) });
  } catch (error) {
    const response = storeErrorResponse(request, error);
    if (response) return response;
    throw error;
  }
}
