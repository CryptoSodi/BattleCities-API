import router from './api/router';
import { withCors } from './middleware/cors';
import { withErrorHandling } from './middleware/errorHandler';

export function dispatch(request: Request): Promise<Response> {
  return withErrorHandling(request, () =>
    withCors(request, () => router.fetch(request)),
  );
}

export default {
  fetch: dispatch,
};
