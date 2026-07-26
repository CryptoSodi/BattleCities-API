import type {
  MultiplayerAssignment,
  MultiplayerRuntimeConfig,
} from '../../../../shared/src';

export function createPlayerRuntime(
  request: Request,
  assignment: MultiplayerAssignment,
  level = 1,
): MultiplayerRuntimeConfig {
  return {
    protocolVersion: 1,
    mode: 'webrtc',
    matchId: assignment.match.id,
    role: 'player',
    playerSlot: assignment.playerSlot,
    level,
    signalingBaseUrl: new URL(request.url).origin,
    joinToken: assignment.joinToken,
  };
}
