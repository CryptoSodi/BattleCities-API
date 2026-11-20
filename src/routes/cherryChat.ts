declare const require: any;
declare const process: any;

import { createJsonResponse, createOptionsResponse } from './_helpers';

const crypto = require('node:crypto');
const sessions = require('../stores/sessionStore');
const rateLimiter = require('../services/rateLimiter');

export function OPTIONS(request: Request): Response { return createOptionsResponse(request); }

export async function POST(request: Request): Promise<Response> {
  const reply = (body: any, status: number) => {
    const response = createJsonResponse(request, body, status);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  };
  if (request.headers.get('origin') !== 'https://cherry.battlecities.com')
    return reply({ error: 'Cherry origin required' }, 403);
  const match = /^Bearer (sess-[a-z0-9-]+)$/i.exec(request.headers.get('authorization') || '');
  const session = match ? await sessions.readSession(match[1]) : null;
  if (!session || session.provider !== 'cherry' || !session.walletAddress)
    return reply({ error: 'Cherry sign-in required' }, 401);
  if (!rateLimiter.allow('cherry-chat-token', session.playerId))
    return reply({ error: 'Too many requests' }, 429);

  const appId = process.env.BATTLECITY_CHERRY_CHAT_EMBED_ID || '2c5b3a65-ec5a-48ed-9eb2-fe558afc12d7';
  const roomId = process.env.BATTLECITY_CHERRY_CHAT_ROOM_ID || 'ad5e064c-a5d7-4bb0-a90f-5b0ea09f39f8';
  const secret = process.env.BATTLECITY_CHERRY_CHAT_SECRET;
  if (!appId || !roomId || !secret || secret.length < 16)
    return reply({ error: 'Chat is not configured' }, 503);
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: any) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: session.walletAddress, app_id: appId, iat: now, exp: now + 300, jti: crypto.randomUUID(),
  })}`;
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return reply({ appId, roomId, walletAddress: session.walletAddress, token: `${payload}.${signature}` }, 200);
}
