import * as airdropClaim from '../routes/airdrops/claim';
import * as airdropEligibility from '../routes/airdrops/eligibility';
import * as googleAuthCallback from '../routes/auth/google/callback';
import * as googleAuthNative from '../routes/auth/google/native';
import * as googleAuthStart from '../routes/auth/google/start';
import * as boostStatus from '../routes/boost/status';
import * as economyAccount from '../routes/economy/account';
import * as economyLedger from '../routes/economy/ledger';
import * as economyPurchase from '../routes/economy/purchase';
import * as events from '../routes/events';
import * as eventDetail from '../routes/events/detail';
import * as eventLeaderboard from '../routes/events/leaderboard';
import * as health from '../routes/health';
import * as matchSubmit from '../routes/matches/submit';
import * as multiplayerDirectStart from '../routes/multiplayer/directStart';
import * as multiplayerEvents from '../routes/multiplayer/events';
import * as multiplayerMatches from '../routes/multiplayer/matches';
import * as phases from '../routes/phases';
import * as player from '../routes/player';
import * as quests from '../routes/quests';
import * as questClaim from '../routes/quests/claim';
import * as rankings from '../routes/rankings';
import * as ready from '../routes/ready';
import * as replays from '../routes/replays';
import * as replayValidate from '../routes/replays/validate';
import * as seasonCurrent from '../routes/seasons/current';
import * as session from '../routes/session';
import * as stakingClaim from '../routes/staking/claim';
import * as stakingLeaderboard from '../routes/staking/leaderboard';
import * as stakingStake from '../routes/staking/stake';
import * as stakingSummary from '../routes/staking/summary';
import * as stakingUnstake from '../routes/staking/unstake';
import * as tradingTokens from '../routes/trading/tokens';
import * as tradingVerifySwap from '../routes/trading/verify-swap';
import * as webrtcSignals from '../routes/webrtcSignals';
import * as webrtcObservers from '../routes/webrtcObservers';
import {
  createJsonResponse,
  createOptionsResponse,
} from '../routes/_helpers';

type RouteHandler = (request: Request) => Response | Promise<Response>;

const routes: { [path: string]: { [method: string]: RouteHandler } } = {
  'airdrops/claim': airdropClaim,
  'airdrops/eligibility': airdropEligibility,
  'auth/google/callback': googleAuthCallback,
  'auth/google/native': googleAuthNative,
  'auth/google/start': googleAuthStart,
  'boost/status': boostStatus,
  'economy/account': economyAccount,
  'economy/ledger': economyLedger,
  'economy/purchase': economyPurchase,
  events,
  'events/detail': eventDetail,
  'events/leaderboard': eventLeaderboard,
  health,
  'matches/submit': matchSubmit,
  'multiplayer/direct/start': multiplayerDirectStart,
  phases,
  player,
  quests,
  'quests/claim': questClaim,
  rankings,
  ready,
  replays,
  'replays/validate': replayValidate,
  'seasons/current': seasonCurrent,
  session,
  'staking/claim': stakingClaim,
  'staking/leaderboard': stakingLeaderboard,
  'staking/stake': stakingStake,
  'staking/summary': stakingSummary,
  'staking/unstake': stakingUnstake,
  'trading/tokens': tradingTokens,
  'trading/verify-swap': tradingVerifySwap,
};

const webrtcSignalRoutePattern =
  /^webrtc\/matches\/([^/]+)\/players\/([^/]+)\/signals\/([^/]+)$/;
const webrtcObserverRoutePattern =
  /^webrtc\/matches\/([^/]+)\/observers$/;
const multiplayerMatchRoutePattern =
  /^multiplayer\/matches\/([^/]+)$/;
const multiplayerMatchActionRoutePattern =
  /^multiplayer\/matches\/([^/]+)\/([^/]+)$/;
const multiplayerEventRoutePattern =
  /^events\/([^/]+)\/(enter|start|leaderboard|prizes\/approve)$/;

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
  if (route === 'multiplayer/matches/live') {
    if (request.method.toUpperCase() === 'GET') {
      return multiplayerMatches.GET(request);
    }
    if (request.method.toUpperCase() === 'OPTIONS') {
      return multiplayerMatches.OPTIONS(request);
    }
    return methodNotAllowed('GET, OPTIONS');
  }

  const multiplayerEventMatch = route.match(multiplayerEventRoutePattern);
  if (multiplayerEventMatch !== null) {
    const [, eventId, action] = multiplayerEventMatch;
    const method = request.method.toUpperCase();
    if (method === 'GET') {
      return multiplayerEvents.GET(request, eventId, action);
    }
    if (method === 'POST') {
      return multiplayerEvents.POST(request, eventId, action);
    }
    if (method === 'OPTIONS') {
      return multiplayerEvents.OPTIONS(request);
    }
    return methodNotAllowed('GET, POST, OPTIONS');
  }

  const multiplayerMatchAction = route.match(multiplayerMatchActionRoutePattern);
  if (multiplayerMatchAction !== null) {
    const [, matchId, action] = multiplayerMatchAction;
    const method = request.method.toUpperCase();
    if (method === 'POST') {
      return multiplayerMatches.POST(request, matchId, action);
    }
    if (method === 'OPTIONS') {
      return multiplayerMatches.OPTIONS(request);
    }
    return methodNotAllowed('POST, OPTIONS');
  }

  const multiplayerMatch = route.match(multiplayerMatchRoutePattern);
  if (multiplayerMatch !== null) {
    const [, matchId] = multiplayerMatch;
    const method = request.method.toUpperCase();
    if (method === 'GET') {
      return multiplayerMatches.GET(request, matchId);
    }
    if (method === 'OPTIONS') {
      return multiplayerMatches.OPTIONS(request);
    }
    return methodNotAllowed('GET, OPTIONS');
  }

  const webrtcObserverMatch = route.match(webrtcObserverRoutePattern);
  if (webrtcObserverMatch !== null) {
    const [, matchId] = webrtcObserverMatch;
    const method = request.method.toUpperCase();
    if (method === 'GET') {
      return webrtcObservers.GET(request, matchId);
    }
    if (method === 'POST') {
      return webrtcObservers.POST(request, matchId);
    }
    if (method === 'OPTIONS') {
      return webrtcObservers.OPTIONS(request);
    }
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: {
        allow: 'GET, POST, OPTIONS',
        'content-type': 'application/json',
      },
    });
  }
  const webrtcSignalMatch = route.match(webrtcSignalRoutePattern);
  if (webrtcSignalMatch !== null) {
    const [, matchId, playerIndex, kind] = webrtcSignalMatch;
    const method = request.method.toUpperCase();

    if (method === 'GET') {
      return webrtcSignals.GET(request, matchId, playerIndex, kind);
    }
    if (method === 'POST') {
      return webrtcSignals.POST(request, matchId, playerIndex, kind);
    }
    if (method === 'OPTIONS') {
      return webrtcSignals.OPTIONS(request);
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: {
        allow: 'GET, POST, OPTIONS',
        'content-type': 'application/json',
      },
    });
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
