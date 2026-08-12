declare const require: any;

import {
  createJsonResponse,
  createOptionsResponse,
} from '../_helpers';

const matchResultStore = require('../../stores/matchResultStore');
const playerStore = require('../../stores/playerStore');
const seasonStore = require('../../stores/seasonStore');

const MATCHES_PER_PAGE = 12;

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
    const replays = await matchResultStore.getPublicPlayerReplay(
      player.id,
      matchResultId,
    );
    return replays === null
      ? createJsonResponse(request, { error: 'Replay not found' }, 404)
      : createJsonResponse(request, { item: { replays } });
  }

  const currentSeason = await seasonStore.getCurrentSeason();
  const page = readPage(request);
  const [allTime, season, recentMatches, totalMatches] = await Promise.all([
    matchResultStore.getPlayerRank(player.id, null),
    matchResultStore.getPlayerRank(player.id, currentSeason.id),
    matchResultStore.getPlayerResults(
      player.id,
      MATCHES_PER_PAGE,
      (page - 1) * MATCHES_PER_PAGE,
    ),
    matchResultStore.getPlayerResultCount(player.id),
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
      recentMatchesPage: {
        page,
        pageSize: MATCHES_PER_PAGE,
        total: totalMatches,
      },
    },
  });
}

function readPage(request: Request): number {
  const value = new URL(request.url).searchParams.get('page');
  const page = Number(value);
  if (!Number.isFinite(page)) {
    return 1;
  }
  return Math.max(1, Math.min(10_000, Math.floor(page)));
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
