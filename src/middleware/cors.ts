function isAllowedOrigin(origin: string | null): boolean {
  if (typeof origin !== 'string' || origin === '') {
    return false;
  }

  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();

    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.endsWith('.battlecities.com') ||
      host === 'battlecities.com' ||
      host === 'www.battlecities.com' ||
      isPrivateIp(host)
    );
  } catch {
    return false;
  }
}

function isPrivateIp(host: string): boolean {
  return (
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  );
}

export function createCorsHeaders(
  request: Request,
  extra: HeadersInit = {},
): Headers {
  const headers = new Headers(extra);
  const origin = request.headers.get('origin');

  if (isAllowedOrigin(origin)) {
    headers.set('access-control-allow-origin', origin);
  }

  headers.set('access-control-allow-credentials', 'true');
  headers.set('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  headers.set('access-control-allow-headers', 'content-type, authorization');
  headers.set('vary', 'origin');

  return headers;
}

export async function withCors(
  request: Request,
  next: () => Response | Promise<Response>,
): Promise<Response> {
  const response = await next();
  const headers = createCorsHeaders(request, response.headers);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
