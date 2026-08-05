const crypto = require('crypto');
const economyStore = require('../stores/economyStore');
const multiplayerStore = require('../stores/multiplayerStore');
const headlessTarget = require('./headlessTarget');

const ACTIVE_LOADOUT_SLOTS = [
  'active-one',
  'active-two',
  'active-three',
  'active-four',
];
const MAX_POWERUP_STACK = 2;
const POWERUP_TYPES = {
  shield: 'shield',
  'base-defence': 'defence',
  freeze: 'freeze',
  speed: 'speed',
  upgrade: 'upgrade',
  'zoom-out': 'zoomout',
  wipeout: 'wipeout',
  'extra-life': 'life',
};

async function getConfig(matchId) {
  const match = await multiplayerStore.getMatch(matchId);
  const target = headlessTarget.normalizeHeadlessTarget(match?.headlessTarget) ||
    headlessTarget.getDefaultHeadlessTarget();
  const baseUrl = headlessTarget.getBroadcasterBaseUrl(target);
  const token = String(process.env.BROADCASTER_SERVICE_TOKEN || '').trim();
  if (baseUrl === '' || token === '') {
    const error = new Error('Broadcaster service is not configured');
    error.code = 'BROADCASTER_NOT_CONFIGURED';
    throw error;
  }
  return { baseUrl, token };
}

function isAuthorizedRequest(request) {
  const configured = String(process.env.BROADCASTER_SERVICE_TOKEN || '').trim();
  const supplied = readBearerToken(request);
  return safeEquals(configured, supplied);
}

async function ensureMatchStarted(matchId, level) {
  const config = await getConfig(matchId);
  const existing = await multiplayerStore.getBroadcasterState(matchId);
  if (existing?.status === 'running') {
    const running = await probeMatch(config, matchId);
    if (running) {
      return existing;
    }
  }

  const runtimeOptions = await getMatchRuntimeOptions(matchId);
  await multiplayerStore.setBroadcasterState(matchId, 'starting');
  let response;
  try {
    response = await fetch(`${config.baseUrl}/matches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ matchId, level, ...runtimeOptions }),
    });
  } catch (cause) {
    await multiplayerStore.setBroadcasterState(matchId, 'failed');
    throw createServiceError('BROADCASTER_START_FAILED', 'Broadcaster is unavailable', cause);
  }

  if (response.status !== 201 && response.status !== 409) {
    await multiplayerStore.setBroadcasterState(matchId, 'failed');
    throw createServiceError(
      'BROADCASTER_START_FAILED',
      `Broadcaster rejected match startup (${response.status})`,
    );
  }

  const body = await readJson(response);
  const workerUrl = normalizeWorkerUrl(
    body?.workerUrl || body?.statusUrl || body?.url,
  );
  await multiplayerStore.setBroadcasterState(matchId, 'running', workerUrl);
  return multiplayerStore.getBroadcasterState(matchId);
}

async function probeMatch(config, matchId) {
  let response;
  try {
    response = await fetch(
      `${config.baseUrl}/matches/${encodeURIComponent(matchId)}`,
      {
        headers: { authorization: `Bearer ${config.token}` },
      },
    );
  } catch (cause) {
    await multiplayerStore.setBroadcasterState(matchId, 'failed');
    throw createServiceError(
      'BROADCASTER_START_FAILED',
      'Broadcaster is unavailable',
      cause,
    );
  }
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    await multiplayerStore.setBroadcasterState(matchId, 'failed');
    throw createServiceError(
      'BROADCASTER_START_FAILED',
      `Broadcaster status check failed (${response.status})`,
    );
  }
  return true;
}

async function getMatchRuntimeOptions(matchId) {
  const match = await multiplayerStore.getMatch(matchId);
  const players = Array.isArray(match?.players) ? match.players : [];
  const accountsBySlot = await Promise.all(
    [0, 1].map(async (playerSlot) => {
      const participant = players.find((player) => player.slot === playerSlot);
      return participant === undefined
        ? null
        : economyStore.readAccount(participant.playerId);
    }),
  );
  return {
    gameType: match?.category || 'direct',
    category:
      match?.category === 'event'
        ? 'event'
        : accountsBySlot.every((account) => account?.provider === 'guest')
          ? 'guest'
          : 'live',
    players: players.map((player) => ({
      playerId: player.playerId,
      displayName: player.displayName || 'Player',
      slot: player.slot,
      tankTier: player.tankTier || 'a',
    })),
    initialPlayerTiers: [0, 1].map((playerSlot) => {
      const player = players.find((candidate) => candidate.slot === playerSlot);
      return player?.tankTier || 'a';
    }),
    playerRunConsumables: accountsBySlot.map(toRunConsumables),
  };
}

async function configureStagePlayer(
  matchId,
  playerSlot,
  replaceConnection = false,
) {
  const config = await getConfig(matchId);
  const options = await getMatchRuntimeOptions(matchId);
  const tier = options.initialPlayerTiers[playerSlot] || 'a';
  const runConsumables = options.playerRunConsumables[playerSlot] || {
    powerups: [],
    powerupCounts: [],
  };
  let response;
  try {
    response = await fetch(
      `${config.baseUrl}/matches/${encodeURIComponent(matchId)}` +
        `/players/${playerSlot + 1}`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          tankTier: tier,
          runConsumables,
          replaceConnection,
        }),
      },
    );
  } catch (cause) {
    throw createServiceError(
      'BROADCASTER_PLAYER_CONFIG_FAILED',
      'Broadcaster is unavailable',
      cause,
    );
  }
  if (!response.ok) {
    throw createServiceError(
      'BROADCASTER_PLAYER_CONFIG_FAILED',
      `Broadcaster rejected stage player configuration (${response.status})`,
    );
  }
}

function toRunConsumables(account) {
  const inventory =
    account !== null && typeof account?.inventory === 'object'
      ? account.inventory
      : {};
  const loadout =
    account !== null && typeof account?.loadout === 'object'
      ? account.loadout
      : {};
  const powerups = [];
  const powerupCounts = [];
  const equippedItems = new Set();

  ACTIVE_LOADOUT_SLOTS.forEach((slot) => {
    const itemId = loadout[slot];
    const powerupType = POWERUP_TYPES[itemId];
    const count = Math.max(0, Math.floor(Number(inventory[itemId]) || 0));
    if (
      powerupType === undefined ||
      count === 0 ||
      equippedItems.has(itemId)
    ) {
      return;
    }
    equippedItems.add(itemId);
    powerups.push(powerupType);
    powerupCounts.push(Math.min(MAX_POWERUP_STACK, count));
  });

  return { powerups, powerupCounts };
}

async function stopMatch(matchId) {
  const existing = await multiplayerStore.getBroadcasterState(matchId);
  if (existing === null || existing.status === 'stopped') {
    return existing;
  }

  const config = await getConfig(matchId);
  let response;
  try {
    response = await fetch(
      `${config.baseUrl}/matches/${encodeURIComponent(matchId)}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${config.token}` },
      },
    );
  } catch (cause) {
    await multiplayerStore.setBroadcasterState(matchId, 'failed');
    throw createServiceError('BROADCASTER_STOP_FAILED', 'Broadcaster is unavailable', cause);
  }

  if (![200, 202, 204, 404, 409].includes(response.status)) {
    await multiplayerStore.setBroadcasterState(matchId, 'failed');
    throw createServiceError(
      'BROADCASTER_STOP_FAILED',
      `Broadcaster rejected match shutdown (${response.status})`,
    );
  }
  await multiplayerStore.setBroadcasterState(matchId, 'stopped');
  return multiplayerStore.getBroadcasterState(matchId);
}

function readBearerToken(request) {
  const authorization = String(request.headers.get('authorization') || '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

function safeEquals(left, right) {
  if (left === '' || right === '') {
    return false;
  }
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function normalizeWorkerUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function createServiceError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

module.exports = {
  configureStagePlayer,
  ensureMatchStarted,
  isAuthorizedRequest,
  stopMatch,
};
