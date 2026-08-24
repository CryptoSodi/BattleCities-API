declare const require: any;

import { createJsonResponse, createOptionsResponse } from '../_helpers';
import { isResponse, requireAdmin, storeErrorResponse } from './_helpers';

const pushDevices = require('../../stores/pushDeviceStore');
const firebaseMessaging = require('../../services/firebaseMessaging');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(request: Request): Promise<Response> {
  const authorization = await requireAdmin(request);
  if (isResponse(authorization)) return authorization;
  return createJsonResponse(request, {
    ok: true,
    configured: firebaseMessaging.isConfigured(),
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
  try {
    const body = await request.json();
    const audience = isTest ? 'player' : body?.audience;
    const playerId = typeof body?.playerId === 'string' ? body.playerId.trim() : '';
    if (audience !== 'all' && audience !== 'player') {
      return createJsonResponse(request, { ok: false, error: 'Choose a notification audience' }, 400);
    }
    if (audience === 'player' && playerId === '') {
      return createJsonResponse(request, { ok: false, error: 'A player is required' }, 400);
    }
    if (!firebaseMessaging.isConfigured()) {
      return createJsonResponse(request, { ok: false, error: 'Firebase messaging is not configured' }, 503);
    }

    const notification = isTest
      ? {
        title: 'Battle Cities test',
        body: 'Your Android notification connection is ready.',
        route: 'home',
        type: 'test',
        imageUrl: '',
        externalUrl: '',
        actionLabel: 'Open',
      }
      : normalizeNotification(body);
    const devices = await pushDevices.listGrantedDevices(audience === 'player' ? playerId : undefined);
    if (devices.length === 0) {
      return createJsonResponse(
        request,
        { ok: false, error: 'No enabled Android devices match this audience' },
        404,
      );
    }

    const delivery = await sendInBatches(devices, notification);
    const sent = delivery.filter((result) => result.status === 'fulfilled').length;
    const failed = delivery.length - sent;
    return createJsonResponse(request, { ok: sent > 0, sent, failed, devices: devices.length });
  } catch (error) {
    const response = storeErrorResponse(request, error);
    if (response !== null) return response;
    throw error;
  }
}

function normalizeMessage(value: unknown, label: string, maximumLength: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized === '') throw new Error(`${label} is required`);
  if (normalized.length > maximumLength) throw new Error(`${label} must be ${maximumLength} characters or fewer`);
  return normalized;
}

function normalizeNotification(body: any) {
  const route = normalizeRoute(body?.route);
  const externalUrl = route === 'external' ? normalizeHttpsUrl(body?.externalUrl, 'External link', true) : '';
  return {
    title: normalizeMessage(body?.title, 'Title', 80),
    body: normalizeMessage(body?.message, 'Message', 240),
    route,
    type: normalizeType(body?.type),
    imageUrl: normalizeHttpsUrl(body?.imageUrl, 'Image URL', false),
    externalUrl,
    actionLabel: normalizeOptionalText(body?.actionLabel, 'Action label', 32),
  };
}

function normalizeRoute(value: unknown): string {
  const route = typeof value === 'string' ? value.trim() : 'home';
  const allowed = new Set(['home', 'play', 'shop', 'rewards', 'social', 'external', 'share']);
  if (!allowed.has(route)) throw new Error('Choose a valid notification destination');
  return route;
}

function normalizeType(value: unknown): string {
  const type = typeof value === 'string' ? value.trim() : 'announcement';
  const allowed = new Set(['announcement', 'reward', 'event', 'social', 'share']);
  if (!allowed.has(type)) throw new Error('Choose a valid notification type');
  return type;
}

function normalizeOptionalText(value: unknown, label: string, maximumLength: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length > maximumLength) throw new Error(`${label} must be ${maximumLength} characters or fewer`);
  return normalized;
}

function normalizeHttpsUrl(value: unknown, label: string, required: boolean): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized === '') {
    if (required) throw new Error(`${label} is required`);
    return '';
  }
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'https:' || url.hostname === '') throw new Error('invalid');
    return url.toString();
  } catch {
    throw new Error(`${label} must be a valid https URL`);
  }
}

async function sendInBatches(devices: any[], notification: any): Promise<PromiseSettledResult<unknown>[]> {
  const results: PromiseSettledResult<unknown>[] = [];
  const batchSize = 25;
  for (let index = 0; index < devices.length; index += batchSize) {
    const batch = devices.slice(index, index + batchSize);
    results.push(...await Promise.allSettled(
      batch.map((device) => firebaseMessaging.sendToToken(device.token, notification)),
    ));
  }
  return results;
}
