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
  try {
    return createJsonResponse(request, { ok: true, overview: await adminStore.getOverview() });
  } catch (error) {
    const response = storeErrorResponse(request, error);
    if (response !== null) return response;
    throw error;
  }
}
