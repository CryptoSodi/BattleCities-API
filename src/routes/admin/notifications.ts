declare const require: any;

import { createJsonResponse, createOptionsResponse } from '../_helpers';
import { isResponse, requireAdmin, storeErrorResponse } from './_helpers';

const pushDevices = require('../../stores/pushDeviceStore');
const firebaseMessaging = require('../../services/firebaseMessaging');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function POST(request: Request): Promise<Response> {
  const authorization = await requireAdmin(request);
  if (isResponse(authorization)) return authorization;

  try {
    const body = await request.json();
    const playerId = typeof body?.playerId === 'string' ? body.playerId.trim() : '';
    if (playerId === '') {
      return createJsonResponse(request, { ok: false, error: 'A player is required' }, 400);
    }
    if (!firebaseMessaging.isConfigured()) {
      return createJsonResponse(request, { ok: false, error: 'Firebase messaging is not configured' }, 503);
    }

    const devices = await pushDevices.listGrantedDevices(playerId);
    if (devices.length === 0) {
      return createJsonResponse(
        request,
        { ok: false, error: 'This player has no Android device with notifications enabled' },
        404,
      );
    }

    const delivery = await Promise.allSettled(
      devices.map((device) => firebaseMessaging.sendToToken(device.token, {
        title: 'Battle Cities test',
        body: 'Your Android notification connection is ready.',
        route: '/',
      })),
    );
    const sent = delivery.filter((result) => result.status === 'fulfilled').length;
    const failed = delivery.length - sent;
    return createJsonResponse(request, { ok: sent > 0, sent, failed, devices: devices.length });
  } catch (error) {
    const response = storeErrorResponse(request, error);
    if (response !== null) return response;
    throw error;
  }
}
