import type {
  MultiplayerAssignment,
  MultiplayerRuntimeConfig,
} from '../../../../shared/src';

export function createPlayerRuntime(
  request: Request,
  assignment: MultiplayerAssignment,
  level = assignment.match.stage,
): MultiplayerRuntimeConfig {
  const player = assignment.match.players.find(
    (candidate) => candidate.slot === assignment.playerSlot,
  );
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
