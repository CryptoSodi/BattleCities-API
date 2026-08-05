const HEADLESS_TARGET_HEADER = 'x-battlecities-headless';

const HEADLESS_TARGETS = new Set(['worker', 'bom1', 'usa']);

function normalizeHeadlessTarget(value) {
  const target = String(value || '').trim().toLowerCase();
  return HEADLESS_TARGETS.has(target) ? target : null;
}

function getDefaultHeadlessTarget() {
  const transport = String(process.env.MULTIPLAYER_TRANSPORT || '')
    .trim()
    .toLowerCase();
  if (transport === 'vercel-websocket') {
    return 'bom1';
  }
  if (transport === 'websocket') {
    return 'worker';
  }
  return 'usa';
}

function resolveRequestHeadlessTarget(request) {
  return normalizeHeadlessTarget(
    request?.headers?.get(HEADLESS_TARGET_HEADER),
  ) || getDefaultHeadlessTarget();
}

function getHeadlessTransport(target) {
  return target === 'usa' ? 'webrtc' : 'websocket';
}

function getWebSocketBaseUrl(target) {
  const value = target === 'bom1'
    ? process.env.VERCEL_WEBSOCKET_BASE_URL
    : process.env.WEBSOCKET_BASE_URL;
  return String(value || '').trim().replace(/\/+$/, '');
}

function getBroadcasterBaseUrl(target) {
  const value = target === 'bom1'
    ? process.env.VERCEL_WEBSOCKET_BROADCASTER_BASE_URL ||
      process.env.VERCEL_WEBSOCKET_BASE_URL
    : target === 'worker'
      ? process.env.WEBSOCKET_BROADCASTER_BASE_URL ||
        process.env.WEBSOCKET_BASE_URL
      : process.env.BROADCASTER_BASE_URL;
  return String(value || '').trim().replace(/\/+$/, '');
}

module.exports = {
  getBroadcasterBaseUrl,
  getDefaultHeadlessTarget,
  getHeadlessTransport,
  getWebSocketBaseUrl,
  normalizeHeadlessTarget,
  resolveRequestHeadlessTarget,
};
