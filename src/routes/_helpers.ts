import { createCorsHeaders } from '../middleware/cors';

export { resolveSessionPlayer } from '../middleware/session';

export function createJsonResponse(
  request: Request,
  body: any,
  status = 200,
  setCookie: string | null = null,
): Response {
  const headers = createCorsHeaders(request, {
    'content-type': 'application/json',
  });

  if (setCookie !== null) {
    headers.set('set-cookie', setCookie);
  }

  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

export function createOptionsResponse(request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: createCorsHeaders(request),
  });
}
