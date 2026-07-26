declare const require: any;

import { createJsonResponse, createOptionsResponse } from './_helpers';

const eventStore = require('../stores/eventStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

// Campaign cards: live and ended events (status resolved from dates).
export async function GET(request: Request): Promise<Response> {
  return createJsonResponse(request, { items: eventStore.listEvents() });
}
