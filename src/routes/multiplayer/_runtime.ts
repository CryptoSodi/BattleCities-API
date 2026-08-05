import type {
  MultiplayerAssignment,
  MultiplayerRuntimeConfig,
} from '../../../../shared/src';
import { createHmac, randomBytes } from 'crypto';

const headlessTarget = require('../../services/headlessTarget');

export function createPlayerRuntime(
  request: Request,
  assignment: MultiplayerAssignment,
  level = assignment.match.stage,
): MultiplayerRuntimeConfig {
  const player = assignment.match.players.find(
    (candidate) => candidate.slot === assignment.playerSlot,
  );
  const target = headlessTarget.normalizeHeadlessTarget(
    assignment.match.headlessTarget,
  ) || headlessTarget.getDefaultHeadlessTarget();
  if (headlessTarget.getHeadlessTransport(target) === 'websocket') {
    const baseUrl = headlessTarget.getWebSocketBaseUrl(target);
    const secret = String(process.env.WEBSOCKET_TICKET_SECRET || '');
    if (!/^https:\/\//.test(baseUrl) || secret.length < 32) {
      throw new Error('WebSocket multiplayer transport is not configured');
    }
    const ticket = createWebSocketTicket(
      assignment.match.id,
      assignment.playerSlot,
      secret,
    );
    const websocketUrl = new URL(
      `${baseUrl}/matches/${encodeURIComponent(assignment.match.id)}/players/${assignment.playerSlot}`,
    );
    websocketUrl.protocol = 'wss:';
    websocketUrl.searchParams.set('ticket', ticket);
    return {
      protocolVersion: 1,
      mode: 'websocket',
      matchId: assignment.match.id,
      role: 'player',
      playerSlot: assignment.playerSlot,
      tankTier: player?.tankTier ?? 'a',
      level,
      websocketUrl: websocketUrl.toString(),
      joinToken: assignment.joinToken,
    };
  }
  return {
    protocolVersion: 1,
    mode: 'webrtc',
    matchId: assignment.match.id,
    role: 'player',
    playerSlot: assignment.playerSlot,
    tankTier: player?.tankTier ?? 'a',
    level,
    signalingBaseUrl: new URL(request.url).origin,
    joinToken: assignment.joinToken,
  };
}

function createWebSocketTicket(
  matchId: string,
  playerSlot: 0 | 1,
  secret: string,
): string {
  const payload = toBase64Url(Buffer.from(JSON.stringify({
    matchId,
    playerSlot,
    expiresAt: Date.now() + 5 * 60 * 1000,
    nonce: toBase64Url(randomBytes(12)),
  })));
  const signature = toBase64Url(createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${signature}`;
}

function toBase64Url(value: Buffer): string {
  return value.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
