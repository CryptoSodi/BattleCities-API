declare const require: any;
declare const process: any;

import {
  DEFAULT_EVENT_ENTRY_FUEL_COST,
  EventPrizeAllocation,
} from '../../../../shared/src';
import {
  createJsonResponse,
  createOptionsResponse,
  resolveSessionPlayer,
} from '../_helpers';
import { createPlayerRuntime } from './_runtime';

const eventStore = require('../../stores/eventStore');
const tournamentStore = require('../../stores/tournamentStore');
const multiplayerStore = require('../../stores/multiplayerStore');
const broadcasterService = require('../../services/broadcasterService');
const headlessTarget = require('../../services/headlessTarget');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(
  request: Request,
  eventId: string,
  action: string,
): Promise<Response> {
  const event = await findEvent(eventId);
  if (event === null) {
    return createJsonResponse(request, { error: 'Event not found' }, 404);
  }
  if (action !== 'leaderboard') {
    return createJsonResponse(request, { error: 'Unknown event action' }, 404);
  }
  const url = new URL(request.url);
  const rows = await multiplayerStore.getEventLeaderboard(
    event.id,
    Number(url.searchParams.get('limit') || '100'),
  );
  return createJsonResponse(request, { event, rows });
}

export async function POST(
  request: Request,
  eventId: string,
  action: string,
): Promise<Response> {
  const event = await findEvent(eventId);
  if (event === null) {
    return createJsonResponse(request, { ok: false, error: 'Event not found' }, 404);
  }

  if (action === 'prizes/approve') {
    return approvePrizes(request, event);
  }
  if (event.status !== 'live') {
    return createJsonResponse(request, { ok: false, error: 'Event is not live' }, 409);
  }

  const player = await resolveSessionPlayer(request);
  if (player === null) {
    return createJsonResponse(request, { ok: false, error: 'Not logged in' }, 401);
  }
  const fuelCost = Math.max(
    0,
    Math.floor(Number(event.entryFuelCost) || DEFAULT_EVENT_ENTRY_FUEL_COST),
  );

  try {
    if (action === 'enter') {
      const entry = await multiplayerStore.enterEvent(player, event, fuelCost);
      return createJsonResponse(request, { ok: true, event, entry }, 201);
    }
    if (action === 'start') {
      const assignment = await multiplayerStore.startEventMatch(
        player,
        event,
        fuelCost,
        headlessTarget.resolveRequestHeadlessTarget(request),
      );
      if (assignment.match.status === 'waiting') {
        return createJsonResponse(request, { ok: true, assignment }, 201);
      }
      await broadcasterService.ensureMatchStarted(
        assignment.match.id,
        Math.max(1, Number(event.levelNumber) || 1),
      );
      return createJsonResponse(
        request,
        { ok: true, assignment, runtime: createPlayerRuntime(request, assignment) },
        201,
      );
    }
  } catch (error) {
    if ((error as any)?.code === 'INSUFFICIENT_FUEL') {
      return createJsonResponse(
        request,
        { ok: false, error: (error as Error).message },
        409,
      );
    }
    throw error;
  }

  return createJsonResponse(request, { ok: false, error: 'Unknown event action' }, 404);
}

async function approvePrizes(request: Request, event: any): Promise<Response> {
  const configuredSecret = String(process.env.BATTLECITY_EVENT_ADMIN_SECRET || '');
  if (configuredSecret === '') {
    return createJsonResponse(
      request,
      { ok: false, error: 'Event prize approval is not configured' },
      503,
    );
  }
  if (request.headers.get('authorization') !== `Bearer ${configuredSecret}`) {
    return createJsonResponse(request, { ok: false, error: 'Forbidden' }, 403);
  }
  if (event.status !== 'ended') {
    return createJsonResponse(request, { ok: false, error: 'Event has not ended' }, 409);
  }

  let body: { allocations?: EventPrizeAllocation[] };
  try {
    body = (await request.json()) as { allocations?: EventPrizeAllocation[] };
  } catch {
    return createJsonResponse(request, { ok: false, error: 'Invalid JSON' }, 400);
  }
  try {
    const approval = await multiplayerStore.approveEventPrizes(
      event.id,
      body.allocations,
    );
    return createJsonResponse(request, { ok: true, approval });
  } catch (error) {
    if ((error as any)?.code === 'INVALID_ALLOCATIONS') {
      return createJsonResponse(
        request,
        { ok: false, error: (error as Error).message },
        400,
      );
    }
    throw error;
  }
}

async function findEvent(value: string): Promise<any> {
  const builtIn = (
    eventStore
      .listEvents()
      .find((event: any) => event.id === value || event.slug === value) || null
  );
  return builtIn || tournamentStore.findPublicEvent(value);
}
