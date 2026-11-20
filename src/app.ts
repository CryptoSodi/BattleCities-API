import router from './api/router';
import { withCors } from './middleware/cors';
import { withErrorHandling } from './middleware/errorHandler';
import { createJsonResponse } from './routes/_helpers';

declare const require: any;
const sessionStore = require('./stores/sessionStore');

export function dispatch(request: Request): Promise<Response> {
  return withErrorHandling(request, () =>
    withCors(request, async () => {
      const authorization = request.headers.get('authorization') || '';
      const match = /^Bearer (sess-[a-z0-9-]+)$/i.exec(authorization);
      if (!match) return router.fetch(request);
      // Existing API routes consume the session cookie. Adapt only verified
      // Cherry bearer sessions internally; never issue a third-party cookie.
      if (request.headers.get('origin') !== 'https://cherry.battlecities.com') {
        return createJsonResponse(request, { error: 'Cherry origin required' }, 403);
      }
      const session = await sessionStore.readSession(match[1]);
      if (!session || session.provider !== 'cherry') {
        return createJsonResponse(request, { authenticated: false }, 401);
      }
      const headers = new Headers(request.headers);
      headers.set('cookie', `battlecity_session=${encodeURIComponent(session.id)}`);
      return router.fetch(new Request(request, { headers }));
    }),
  );
}

export default {
  fetch: dispatch,
};
