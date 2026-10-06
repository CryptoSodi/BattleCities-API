declare const require: any;
import { createJsonResponse, createOptionsResponse } from '../_helpers';
import { isResponse, requireAdmin } from './_helpers';
const reviews = require('../../stores/matchPrizeReviewStore');
export function OPTIONS(request: Request): Response { return createOptionsResponse(request); }
export async function GET(request: Request): Promise<Response> {
  const admin = await requireAdmin(request); if (isResponse(admin)) return admin;
  const url = new URL(request.url), limit = Number(url.searchParams.get('limit') || 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return createJsonResponse(request, { error: 'Invalid limit' }, 400);
  const items = await reviews.list(limit, url.searchParams.get('before'));
  return createJsonResponse(request, { items, nextBefore: items.length === limit ? items[items.length - 1].id : null });
}
export async function POST(request: Request): Promise<Response> {
  const admin = await requireAdmin(request); if (isResponse(admin)) return admin;
  try {
    const body = await request.json();
    return createJsonResponse(request, { ok: true, review: await reviews.review(body.resultId, body.decision, body.reason, admin.player.id) });
  } catch (e: any) { return createJsonResponse(request, { error: e.message }, 400); }
}
