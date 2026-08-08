declare const require: any;

import {
  createJsonResponse,
  createOptionsResponse,
} from '../_helpers';

const matchResultStore = require('../../stores/matchResultStore');
const playerStore = require('../../stores/playerStore');
const seasonStore = require('../../stores/seasonStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(
  request: Request,
  playerId: string,
  matchResultId: string | null = null,
): Promise<Response> {
  const player = await playerStore.readPlayer(playerId);
  if (player === null) {
    return createJsonResponse(request, { error: 'Player not found' }, 404);
  }

  if (matchResultId !== null) {
    const replay = await matchResultStore.getPublicPlayerReplay(
      player.id,
      matchResultId,
    );
    return replay === null
      ? createJsonResponse(request, { error: 'Replay not found' }, 404)
      : createJsonResponse(request, { item: { replay } });
  }

  const currentSeason = await seasonStore.getCurrentSeason();
  const [allTime, season, recentMatches] = await Promise.all([
    matchResultStore.getPlayerRank(player.id, null),
    matchResultStore.getPlayerRank(player.id, currentSeason.id),
    matchResultStore.getPlayerResults(player.id, 12),
  ]);

  return createJsonResponse(request, {
    item: {
      id: player.id,
      provider: player.provider,
      displayName: player.displayName,
      walletAddress: player.provider === 'wallet' ? player.walletAddress : null,
      avatarUrl: player.provider === 'google' ? player.googlePicture : null,
      joinedAt: player.createdAt,
      lastSeenAt: player.lastSeenAt,
      highscores: {
        primary: Number(player.highscorePrimary) || 0,
        secondary: Number(player.highscoreSecondary) || 0,
      },
      stats: {
        allTime: toPublicRank(allTime),
        currentSeason: {
          id: currentSeason.id,
          name: currentSeason.name,
          ...toPublicRank(season),
        },
      },
      recentMatches,
    },
  });
}

function toPublicRank(rank: any): {
  rank: number | null;
  totalPoints: number;
  matches: number;
} {
  return {
    rank: rank === null ? null : rank.rank,
    totalPoints: rank === null ? 0 : rank.totalPoints,
    matches: rank === null ? 0 : rank.matches,
  };
}
