declare const require: any;

import {
  createJsonResponse,
  createOptionsResponse,
  resolveSessionPlayer,
} from '../_helpers';

const eventStore = require('../../stores/eventStore');
const tournamentStore = require('../../stores/tournamentStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

// Event hero + quests (with the caller's progress) + currency balance + own
// event rank. Works logged-out (zero progress).
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug') || '';

  const player = await resolveSessionPlayer(request);
  const event = eventStore.findEventBySlug(slug);
  if (event === null) {
    const tournament = await tournamentStore.findPublicEvent(slug);
    if (tournament === null) {
      return createJsonResponse(request, { error: 'Event not found' }, 404);
    }
    const rows = await tournamentStore.getLeaderboard(tournament.id, 250);
    const ownRow = player === null
      ? null
      : rows.find((row: any) => row.playerId === player.id) || null;
    return createJsonResponse(request, {
      item: { ...tournament, currencyBalance: 0, quests: [] },
      me: ownRow === null ? null : { rank: ownRow.rank, amount: ownRow.score },
    });
  }

  const boards = await eventStore.getQuestBoard(player, slug);
  const me =
    player === null
      ? null
      : await eventStore.getPlayerEventRank(player.id, slug);

  return createJsonResponse(request, { item: boards[0], me });
}
