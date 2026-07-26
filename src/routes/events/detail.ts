declare const require: any;

import {
  createJsonResponse,
  createOptionsResponse,
  resolveSessionPlayer,
} from '../_helpers';

const eventStore = require('../../stores/eventStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

// Event hero + quests (with the caller's progress) + currency balance + own
// event rank. Works logged-out (zero progress).
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug') || '';

  const event = eventStore.findEventBySlug(slug);
  if (event === null) {
    return createJsonResponse(request, { error: 'Event not found' }, 404);
  }

  const player = await resolveSessionPlayer(request);
  const boards = await eventStore.getQuestBoard(player, slug);
  const me =
    player === null
      ? null
      : await eventStore.getPlayerEventRank(player.id, slug);

  return createJsonResponse(request, { item: boards[0], me });
}
