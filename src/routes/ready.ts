declare const require: any;

import { createJsonResponse } from './_helpers';

const database = require('../database');

export async function GET(request: Request): Promise<Response> {
  try {
    const readiness = await database.getReadiness();
    return createJsonResponse(request, readiness);
  } catch (error) {
    console.error('[battlecities-api] readiness check failed', error);
    return createJsonResponse(
      request,
      { ready: false, error: 'Database is not ready' },
      503,
    );
  }
}
