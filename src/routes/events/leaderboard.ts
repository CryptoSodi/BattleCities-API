declare const require: any;

import { createJsonResponse, createOptionsResponse } from '../_helpers';

const eventStore = require('../../stores/eventStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug') || '';

  const rows = await eventStore.getEventLeaderboard(slug, 20);
  if (rows === null) {
    return createJsonResponse(request, { error: 'Event not found' }, 404);
  }

  return createJsonResponse(request, { rows });
}
