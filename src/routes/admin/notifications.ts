declare const require: any;

import { createJsonResponse, createOptionsResponse } from '../_helpers';
import { isResponse, requireAdmin, storeErrorResponse } from './_helpers';

const pushDevices = require('../../stores/pushDeviceStore');
const firebaseMessaging = require('../../services/firebaseMessaging');
const { normalizeNotification, isValidToken } = require('../../services/notificationPayload');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(request: Request): Promise<Response> {
  const authorization = await requireAdmin(request);
  if (isResponse(authorization)) return authorization;
  return createJsonResponse(request, {
    ok: true,
    configured: firebaseMessaging.isConfigured(),
    androidPackage: firebaseMessaging.ANDROID_PACKAGE,
    firebaseProjectId: firebaseMessaging.PROJECT_ID,
    enabledDevices: await pushDevices.getGrantedDeviceCount(),
  });
}

export async function POST(request: Request): Promise<Response> {
  return sendNotification(request, false);
}

export async function TEST_POST(request: Request): Promise<Response> {
  return sendNotification(request, true);
}

async function sendNotification(request: Request, isTest: boolean): Promise<Response> {
  const authorization = await requireAdmin(request);
  if (isResponse(authorization)) return authorization;
  let body: any;
  try { body = await request.json(); }
  catch { return createJsonResponse(request, { ok: false, error: 'Invalid JSON' }, 400); }
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return createJsonResponse(request, { ok: false, error: 'A notification is required' }, 400);
    }
    const audience = isTest ? (body.token === undefined ? 'player' : 'device') : body.audience;
    const playerId = typeof body.playerId === 'string' ? body.playerId.trim() : '';
    if (audience !== 'all' && audience !== 'player' && audience !== 'device') {
      return createJsonResponse(request, { ok: false, error: 'Choose a notification audience' }, 400);
    }
    if (body.playerId !== undefined && (typeof body.playerId !== 'string' || (playerId !== '' && !/^ply-[a-z0-9-]{1,124}$/i.test(playerId)))) {
      return createJsonResponse(request, { ok: false, error: 'Invalid player ID' }, 400);
    }
    if (audience === 'player' && playerId === '') {
      return createJsonResponse(request, { ok: false, error: 'A player is required' }, 400);
    }
    if (audience === 'device' && !isValidToken(body.token)) {
      return createJsonResponse(request, { ok: false, error: 'A valid registered device token is required' }, 400);
    }
    if (audience === 'all' && (playerId || body.token !== undefined)) {
      return createJsonResponse(request, { ok: false, error: 'A broadcast cannot include a player or device target' }, 400);
    }

    const notification = isTest
      ? normalizeNotification({
        title: 'Battle Cities test',
        body: 'Your Android notification connection is ready.',
        route: 'home',
        type: 'announcement',
        actionLabel: 'Open',
      })
      : normalizeNotification(body);
    if (!firebaseMessaging.isConfigured()) {
      return createJsonResponse(request, { ok: false, error: 'Firebase messaging is not configured for battle-cities-84acd' }, 503);
    }
    const targetPlayer = audience === 'player' || audience === 'device' ? playerId || undefined : undefined;
    const devices = await pushDevices.listGrantedDevices(targetPlayer, audience === 'device' ? body.token : undefined);
    if (devices.length === 0) {
      return createJsonResponse(
        request,
        { ok: false, error: 'No enabled Android devices match this audience' },
        404,
      );
    }

    const delivery = await sendInBatches(devices, notification, targetPlayer);
    const status = delivery.sent > 0 ? 200 : delivery.failed > 0 ? 502 : 409;
    return createJsonResponse(request, { ok: delivery.sent > 0, ...delivery }, status);
  } catch (error) {
    if ((error as any)?.code === 'INVALID_NOTIFICATION') {
      return createJsonResponse(request, { ok: false, error: (error as Error).message }, 400);
    }
    const response = storeErrorResponse(request, error);
    if (response !== null) return response;
    throw error;
  }
}

async function sendInBatches(devices: any[], notification: any, playerId?: string) {
  const totals = { sent: 0, failed: 0, removed: 0, skipped: 0, devices: devices.length };
  const batchSize = 25;
  for (let index = 0; index < devices.length; index += batchSize) {
    const batch = devices.slice(index, index + batchSize);
    const results = await Promise.allSettled(batch.map(async (device) => {
      // Opt-outs and ownership changes after audience selection must be respected.
      const current = await pushDevices.getGrantedDevice(device.token, playerId);
      if (!current) return { sent: 0, failed: 0, removed: 0, skipped: 1 };
      try {
        await firebaseMessaging.sendToToken(current.token, notification);
        return { sent: 1, failed: 0, removed: 0, skipped: 0 };
      } catch (error) {
        const removed = (error as any)?.invalidToken
          ? await pushDevices.removeInvalidDevice(current.token, current.lastSeenAt) : false;
        return { sent: 0, failed: 1, removed: removed ? 1 : 0, skipped: 0 };
      }
    }));
    for (const result of results) {
      if (result.status === 'rejected') { totals.failed++; continue; }
      for (const key of ['sent', 'failed', 'removed', 'skipped'] as const) totals[key] += result.value[key];
    }
  }
  return totals;
}
