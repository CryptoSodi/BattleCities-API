declare const require: any;

import { createJsonResponse, createOptionsResponse } from '../_helpers';
import { isResponse, requireAdmin, storeErrorResponse } from './_helpers';

const adminStore = require('../../stores/adminStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(request: Request): Promise<Response> {
  const authorization = await requireAdmin(request);
  if (isResponse(authorization)) return authorization;
  const url = new URL(request.url);
  try {
    return createJsonResponse(request, {
      ok: true,
      ...(await adminStore.listReplays({
        limit: url.searchParams.get('limit'),
        offset: url.searchParams.get('offset'),
      })),
    });
  } catch (error) {
    const response = storeErrorResponse(request, error);
    if (response !== null) return response;
    throw error;
  }
}
