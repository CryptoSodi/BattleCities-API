declare const require: any;

import { createJsonResponse, createOptionsResponse } from '../_helpers';
import { isResponse, requireAdmin, storeErrorResponse } from './_helpers';

const tournamentStore = require('../../stores/tournamentStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(
  request: Request,
  tournamentId: string | null = null,
  action: string | null = null,
): Promise<Response> {
  const authorization = await requireAdmin(request);
  if (isResponse(authorization)) return authorization;
  try {
    if (tournamentId === null) {
      return createJsonResponse(request, {
        ok: true,
        items: await tournamentStore.listTournaments(),
      });
    }
    const tournament = await tournamentStore.getTournament(tournamentId);
    if (tournament === null) {
      return createJsonResponse(request, { ok: false, error: 'Tournament not found' }, 404);
    }
    if (action === 'leaderboard') {
      const rows = await tournamentStore.getLeaderboard(tournament.id, 250);
      const distributions = await tournamentStore.listDistributions(tournament.id);
      return createJsonResponse(request, { ok: true, tournament, rows, distributions });
    }
    if (action !== null) {
      return createJsonResponse(request, { ok: false, error: 'Unknown tournament action' }, 404);
    }
    return createJsonResponse(request, { ok: true, tournament });
  } catch (error) {
    const response = storeErrorResponse(request, error);
    if (response !== null) return response;
    throw error;
  }
}

export async function POST(
  request: Request,
  tournamentId: string | null = null,
  action: string | null = null,
): Promise<Response> {
  const authorization = await requireAdmin(request);
  if (isResponse(authorization)) return authorization;
  const body = await readJson(request);
  if (body === null) {
    return createJsonResponse(request, { ok: false, error: 'Invalid JSON' }, 400);
  }
  try {
    if (tournamentId === null) {
      const tournament = await tournamentStore.createTournament(
        authorization.player.id,
        body,
      );
      return createJsonResponse(request, { ok: true, tournament }, 201);
    }
    if (action === 'prizes/distribute') {
      const result = await tournamentStore.distributePrizes(
        authorization.player.id,
        tournamentId,
        body.allocations,
      );
      if (result === null) {
        return createJsonResponse(request, { ok: false, error: 'Tournament not found' }, 404);
      }
      return createJsonResponse(request, { ok: true, ...result });
    }
    return createJsonResponse(request, { ok: false, error: 'Unknown tournament action' }, 404);
  } catch (error) {
    const response = storeErrorResponse(request, error);
    if (response !== null) return response;
    throw error;
  }
}

export async function PATCH(request: Request, tournamentId: string): Promise<Response> {
  const authorization = await requireAdmin(request);
  if (isResponse(authorization)) return authorization;
  const body = await readJson(request);
  if (body === null) {
    return createJsonResponse(request, { ok: false, error: 'Invalid JSON' }, 400);
  }
  try {
    const tournament = await tournamentStore.updateTournament(
      authorization.player.id,
      tournamentId,
      body,
    );
    return tournament === null
      ? createJsonResponse(request, { ok: false, error: 'Tournament not found' }, 404)
      : createJsonResponse(request, { ok: true, tournament });
  } catch (error) {
    const response = storeErrorResponse(request, error);
    if (response !== null) return response;
    throw error;
  }
}

async function readJson(request: Request): Promise<any | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
