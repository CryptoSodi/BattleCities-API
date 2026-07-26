declare const require: any;

import {
  createJsonResponse,
  createOptionsResponse,
  resolveSessionPlayer,
} from './_helpers';

const eventStore = require('../stores/eventStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

// Active quests + the caller's progress across every event.
export async function GET(request: Request): Promise<Response> {
  const player = await resolveSessionPlayer(request);
  const items = await eventStore.getQuestBoard(player, null);

  return createJsonResponse(request, { items });
}
