import { createCorsHeaders } from './cors';

export async function withErrorHandling(
  request: Request,
  next: () => Response | Promise<Response>,
): Promise<Response> {
  try {
    return await next();
  } catch (error) {
    console.error('[battlecities-api] route failed', error);

    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: createCorsHeaders(request, {
        'content-type': 'application/json',
      }),
    });
  }
}
