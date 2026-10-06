declare const require: any;
import { createJsonResponse, createOptionsResponse } from './_helpers';
const competitions = require('../services/competitions');
const store = require('../stores/competitionStore');

export function OPTIONS(request: Request): Response { return createOptionsResponse(request); }
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') || 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return createJsonResponse(request, { error: 'limit must be 1–100' }, 400);
  const isPayouts = url.pathname.endsWith('/payouts');
  if (isPayouts) {
    const items = await store.listPayouts({ limit, periodId: url.searchParams.get('periodId'),
      playerId: url.searchParams.get('playerId'), before: url.searchParams.get('before') });
    return createJsonResponse(request, { items: items.map(competitions.publicPayout), nextBefore: items.length === limit ? items[items.length - 1].id : null });
  }
  const id = url.searchParams.get('id');
  if (id) {
    try {
      const period = await competitions.historicalCycle(id);
      return createJsonResponse(request, { item: { id: period.id, startsAt: period.startsAt, endsAt: period.endsAt,
        archived: !!period.closedAt, rows: period.rows || await competitions.board(period),
        payouts: (await store.listPayouts({ periodId: id, limit: 100 })).map(competitions.publicPayout) } });
    } catch (error: any) { return createJsonResponse(request, { error: error.message }, 400); }
  }
  const before = url.searchParams.get('before');
  if (before && !Number.isFinite(Date.parse(before))) return createJsonResponse(request, { error: 'Invalid before timestamp' }, 400);
  return createJsonResponse(request, await competitions.listCycles(before ? Date.parse(before) : Date.now(), limit));
}
