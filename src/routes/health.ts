import { createJsonResponse } from './_helpers';

export function GET(request: Request): Response {
  return createJsonResponse(request, {
    ok: true,
    service: 'battle-cities-api',
    runtime: 'node',
  });
}
