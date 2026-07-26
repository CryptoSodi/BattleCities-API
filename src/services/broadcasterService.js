const crypto = require('crypto');
const multiplayerStore = require('../stores/multiplayerStore');

function getConfig() {
  const baseUrl = String(process.env.BROADCASTER_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
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
  const existing = await multiplayerStore.getBroadcasterState(matchId);
  if (existing?.status === 'running') {
    return existing;
  }

  const config = getConfig();
  await multiplayerStore.setBroadcasterState(matchId, 'starting');
  let response;
  try {
    response = await fetch(`${config.baseUrl}/matches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ matchId, level }),
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

async function stopMatch(matchId) {
  const existing = await multiplayerStore.getBroadcasterState(matchId);
  if (existing === null || existing.status === 'stopped') {
    return existing;
  }

  const config = getConfig();
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
  ensureMatchStarted,
  isAuthorizedRequest,
  stopMatch,
};
