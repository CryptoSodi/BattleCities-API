declare const require: any;

import { createJsonResponse, createOptionsResponse } from './_helpers';

const playerPolicy = require('../services/playerPolicy');
const leaderboardSnapshotStore = require('../stores/leaderboardSnapshotStore');
const matchResultStore = require('../stores/matchResultStore');
const perkBadges = require('../services/perkBadges');
const playerStore = require('../stores/playerStore');
const seasonStore = require('../stores/seasonStore');
const sessionIdentity = require('../services/sessionIdentity');
const sessionStore = require('../stores/sessionStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

// Hall of Fame data. scope=gaming|trading; seasonId scopes gaming rows to a
// season ('' or 'all' => all-time). Trading rows are an empty placeholder
// until Milestone 5 lands trading volume — the response shape is final so the
// client tab can ship now.
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const scope = url.searchParams.get('scope') === 'trading' ? 'trading' : 'gaming';
  const requestedSeasonId = url.searchParams.get('seasonId') || '';

  const currentSeason = await seasonStore.getCurrentSeason();
  const seasons = await seasonStore.listSeasons();

  const seasonId =
    requestedSeasonId === '' || requestedSeasonId === 'all'
      ? requestedSeasonId === 'all'
        ? null
        : currentSeason.id
      : requestedSeasonId;

  // A closed season serves its immutable snapshot (with the perks frozen at
  // close time); live scopes compute fresh and resolve badges now.
  let rows = [];
  if (scope === 'gaming') {
    const snapshot =
      seasonId === null
        ? null
        : await leaderboardSnapshotStore.readSnapshot('gaming', seasonId);

    if (snapshot !== null) {
      rows = snapshot;
    } else {
      rows = await matchResultStore.getLeaderboard(seasonId, 20);
      const badges = await perkBadges.getPerkBadges(
        rows.map((row: any) => row.playerId),
      );
      rows = rows.map((row: any) => ({
        ...row,
        perks: badges[row.playerId] || [],
      }));
    }
  }

  const me = await resolveMe(request, scope, seasonId);

  return createJsonResponse(request, {
    scope,
    seasonId,
    currentSeason: seasonStore.toPublicSeason(currentSeason),
    seasons: seasons.map((season: any) => seasonStore.toPublicSeason(season)),
    rows: rows.map(toPublicRow),
    me,
  });
}

async function resolveMe(
  request: Request,
  scope: string,
  seasonId: string | null,
): Promise<any> {
  const sessionId = sessionIdentity.resolveSession(
    request.headers.get('cookie') || '',
  );
  if (sessionId === null) {
    return null;
  }

  const session = await sessionStore.readSession(sessionId);
  if (session === null || session.playerId === null) {
    return null;
  }

  const player = await playerStore.readPlayer(session.playerId);
  if (player === null) {
    return null;
  }

  // Guests are virtual players — permanently unranked; the client shows a
  // "log in to compete" state instead of a rank.
  if (playerPolicy.isVirtualPlayer(player)) {
    return {
      displayName: player.displayName,
      rank: null,
      totalPoints: 0,
      matches: 0,
      guest: true,
    };
  }

  if (scope !== 'gaming') {
    return { displayName: player.displayName, rank: null, totalPoints: 0 };
  }

  const rank = await matchResultStore.getPlayerRank(player.id, seasonId);
  return {
    displayName: player.displayName,
    rank: rank === null ? null : rank.rank,
    totalPoints: rank === null ? 0 : rank.totalPoints,
    matches: rank === null ? 0 : rank.matches,
  };
}

function toPublicRow(row: any): any {
  return {
    playerId: row.playerId,
    rank: row.rank,
    displayName: row.displayName,
    walletAddress: row.walletAddress,
    totalPoints: row.totalPoints,
    matches: row.matches,
    perks: Array.isArray(row.perks) ? row.perks : [],
  };
}
