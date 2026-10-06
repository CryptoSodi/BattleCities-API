import * as adminCompetitions from '../routes/admin/competitions';
import * as adminMatchReviews from '../routes/admin/matchReviews';
import * as economyCatalog from '../routes/economy/catalog';
import * as nativeOAuth from '../routes/integrations/nativeOAuth';
import * as skrSwap from '../routes/trading/swap';
import * as leaderboardHistory from '../routes/leaderboardHistory';
import * as adminMatches from '../routes/admin/matches';
import * as adminOverview from '../routes/admin/overview';
import * as adminPlayers from '../routes/admin/players';
import * as adminPlayerXConnection from '../routes/admin/playerXConnection';
import * as adminLiveUsers from '../routes/admin/liveUsers';
import * as adminNotifications from '../routes/admin/notifications';
import * as adminXRepostTasks from '../routes/admin/xRepostTasks';
import * as adminXCommentTasks from '../routes/admin/xCommentTasks';
import * as adminReplays from '../routes/admin/replays';
import * as adminSession from '../routes/admin/session';
import * as economyAccount from '../routes/economy/account';
import * as economyConsumePowerup from '../routes/economy/consume-powerup';
import * as economyDropClaim from '../routes/economy/dropClaim';
import * as economyDropRoll from '../routes/economy/dropRoll';
import * as economyLedger from '../routes/economy/ledger';
import * as economyPurchaseQuote from '../routes/economy/purchaseQuote';
import * as economyPurchaseVerify from '../routes/economy/purchaseVerify';
import * as economyWalletBalance from '../routes/economy/walletBalance';
import * as health from '../routes/health';
import * as leaderboardRewards from '../routes/leaderboardRewards';
import * as discordInteractions from '../routes/integrations/discord/interactions';
import * as discordVerifiedUsers from '../routes/integrations/discord/verifiedUsers';
import * as discordVerification from '../routes/integrations/discord/verification';
import * as discordClaimReward from '../routes/integrations/discord/claimReward';
import * as discordOAuthCallback from '../routes/integrations/discord/oauth/callback';
import * as discordOAuthStart from '../routes/integrations/discord/oauth/start';
import * as xOAuthCallback from '../routes/integrations/x/oauth/callback';
import * as xOAuthStart from '../routes/integrations/x/oauth/start';
import * as xStatus from '../routes/integrations/x/status';
import * as xVerifyFollow from '../routes/integrations/x/verifyFollow';
import * as xVerifyRepost from '../routes/integrations/x/verifyRepost';
import * as xVerifyComment from '../routes/integrations/x/verifyComment';
import * as matchSubmit from '../routes/matches/submit';
import * as notificationDevices from '../routes/notifications/devices';
import * as player from '../routes/player';
import * as presence from '../routes/presence';
import * as playerProfile from '../routes/players/profile';
import * as rankings from '../routes/rankings';
import * as ready from '../routes/ready';
import * as replays from '../routes/replays';
import * as replayValidate from '../routes/replays/validate';
import * as seasonCurrent from '../routes/seasons/current';
import * as session from '../routes/session';
import * as tradingTokens from '../routes/trading/tokens';
import * as tradingVerifySwap from '../routes/trading/verify-swap';
import { createJsonResponse, createOptionsResponse } from '../routes/_helpers';

type RouteHandler = (request: Request) => Response | Promise<Response>;

const routes: { [path: string]: { [method: string]: RouteHandler } } = {
  'admin/matches': adminMatches,
  'admin/notifications': adminNotifications,
  'admin/notifications/test': {
    OPTIONS: adminNotifications.OPTIONS,
    POST: adminNotifications.TEST_POST,
  },
  'admin/site-settings/live-users': adminLiveUsers,
  'admin/x/repost-tasks': adminXRepostTasks,
  'admin/x/comment-tasks': adminXCommentTasks,
  'admin/overview': adminOverview,
  'admin/players': adminPlayers,
  'admin/replays': adminReplays,
  'admin/session': adminSession,
  'admin/competitions': adminCompetitions,
  'admin/match-reviews': adminMatchReviews,
  'economy/catalog': economyCatalog,
  'seasons/pass': economyCatalog,
  'integrations/x/oauth/native/start': { POST: nativeOAuth.POST, OPTIONS: nativeOAuth.OPTIONS },
  'integrations/discord/oauth/native/start': { POST: nativeOAuth.POST, OPTIONS: nativeOAuth.OPTIONS },
  'integrations/oauth/native/status': { GET: nativeOAuth.GET, OPTIONS: nativeOAuth.OPTIONS },
  'trading/swap/quote': skrSwap,
  'trading/swap/execute': skrSwap,
  'leaderboard/cycles': leaderboardHistory,
  'leaderboard/payouts': leaderboardHistory,
  'economy/account': economyAccount,
  'economy/powerups/consume': economyConsumePowerup,
  'economy/drops/claim': economyDropClaim,
  'economy/drops/roll': economyDropRoll,
  'economy/ledger': economyLedger,
  'economy/purchase/quote': economyPurchaseQuote,
  'economy/purchase/verify': economyPurchaseVerify,
  'economy/wallet-balance': economyWalletBalance,
  health,
  'integrations/discord/interactions': discordInteractions,
  'integrations/discord/verification': discordVerification,
  'integrations/discord/claim-reward': discordClaimReward,
  'integrations/discord/oauth/callback': discordOAuthCallback,
  'integrations/discord/oauth/start': discordOAuthStart,
  'integrations/x/oauth/callback': xOAuthCallback,
  'integrations/x/oauth/start': xOAuthStart,
  'integrations/x/status': xStatus,
  'integrations/x/verify-follow': xVerifyFollow,
  'integrations/x/verify-repost': xVerifyRepost,
  'integrations/x/verify-comment': xVerifyComment,
  'leaderboard/rewards': leaderboardRewards,
  'matches/submit': matchSubmit,
  'notifications/devices': notificationDevices,
  player,
  presence,
  rankings,
  ready,
  replays,
  'replays/validate': replayValidate,
  'seasons/current': seasonCurrent,
  session,
  'trading/tokens': tradingTokens,
  'trading/verify-swap': tradingVerifySwap,
};

const playerProfileRoutePattern = /^players\/([^/]+)\/profile(?:\/matches\/([^/]+)\/replay)?$/;
const discordVerifiedUserRoutePattern = /^integrations\/discord\/verified-users\/([^/]+)$/;
const adminPlayerXConnectionRoutePattern = /^admin\/players\/(ply-[a-z0-9-]+)\/x-connection$/i;

function resolveRoute(request: Request): string {
  const url = new URL(request.url);
  const rewrittenRoute = url.searchParams.get('__route');

  if (rewrittenRoute !== null) {
    return rewrittenRoute.replace(/^\/+|\/+$/g, '');
  }

  return url.pathname.replace(/^\/api\//, '').replace(/^\/+|\/+$/g, '');
}

async function dispatch(request: Request): Promise<Response> {
  const route = resolveRoute(request);
  const adminPlayerXConnectionMatch = route.match(adminPlayerXConnectionRoutePattern);
  if (adminPlayerXConnectionMatch !== null) {
    const [, playerId] = adminPlayerXConnectionMatch;
    const method = request.method.toUpperCase();
    if (method === 'DELETE') {
      return adminPlayerXConnection.DELETE(request, playerId);
    }
    if (method === 'OPTIONS') {
      return adminPlayerXConnection.OPTIONS(request);
    }
    return methodNotAllowed('DELETE, OPTIONS');
  }
  const discordVerifiedUserMatch = route.match(discordVerifiedUserRoutePattern);
  if (discordVerifiedUserMatch !== null) {
    const [, discordUserId] = discordVerifiedUserMatch;
    const method = request.method.toUpperCase();
    if (method === 'GET') {
      return discordVerifiedUsers.GET(request, discordUserId);
    }
    if (method === 'OPTIONS') {
      return discordVerifiedUsers.OPTIONS(request);
    }
    return methodNotAllowed('GET, OPTIONS');
  }
  const playerProfileMatch = route.match(playerProfileRoutePattern);
  if (playerProfileMatch !== null) {
    const [, playerId, matchResultId = null] = playerProfileMatch;
    const method = request.method.toUpperCase();
    if (method === 'GET') {
      return playerProfile.GET(request, playerId, matchResultId);
    }
    if (method === 'OPTIONS') {
      return playerProfile.OPTIONS(request);
    }
    return methodNotAllowed('GET, OPTIONS');
  }
  const routeModule = routes[route];

  if (routeModule === undefined) {
    return createJsonResponse(request, { error: 'API route not found' }, 404);
  }

  const method = request.method.toUpperCase();
  const handler = routeModule[method];

  if (handler !== undefined) {
    return handler(request);
  }

  if (method === 'OPTIONS') {
    return createOptionsResponse(request);
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: {
      allow: Object.keys(routeModule).join(', '),
      'content-type': 'application/json',
    },
  });
}

function methodNotAllowed(allow: string): Response {
  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: {
      allow,
      'content-type': 'application/json',
    },
  });
}

export default {
  fetch: dispatch,
};
