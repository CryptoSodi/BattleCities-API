const crypto = require('crypto');

const AUTHORIZATION_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/v10/oauth2/token';
const CURRENT_USER_URL = 'https://discord.com/api/v10/users/@me';
const CALLBACK_PATH = '/api/integrations/discord/oauth/callback';
const STATE_TTL_MS = 10 * 60 * 1000;

function getConfig() {
  return {
    clientId: String(process.env.DISCORD_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.DISCORD_CLIENT_SECRET || '').trim(),
    guildId: String(process.env.DISCORD_GUILD_ID || '').trim(),
    redirectUri: String(process.env.DISCORD_OAUTH_REDIRECT_URI || '').trim(),
    stateSecret: String(process.env.DISCORD_OAUTH_STATE_SECRET || '').trim(),
  };
}

function isConfigured() {
  const config = getConfig();
  return (
    config.clientId !== '' &&
    config.clientSecret !== '' &&
    config.guildId !== '' &&
    config.stateSecret !== ''
  );
}

function createAuthorizationUrl(origin, playerId, sessionId) {
  const config = requireConfig();
  const redirectUri = getRedirectUri(origin);
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify guilds.members.read',
    state: createState({ playerId, sessionId, redirectUri }),
  });
  return `${AUTHORIZATION_URL}?${params.toString()}`;
}

async function completeVerification({ code, state, sessionId }) {
  const statePayload = verifyState(state);
  if (statePayload === null || statePayload.sessionId !== sessionId) {
    throw new Error('Invalid Discord OAuth state');
  }

  const accessToken = await exchangeCode(code, statePayload.redirectUri);
  const profile = await fetchCurrentUser(accessToken);
  const isGuildMember = await checkGuildMembership(accessToken);
  if (!isGuildMember) {
    throw new Error('Join the Battle Cities Discord server before verifying');
  }

  return { playerId: statePayload.playerId, profile };
}

async function exchangeCode(code, redirectUri) {
  const config = requireConfig();
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) {
    throw new Error('Discord token exchange failed');
  }
  const body = await response.json();
  if (typeof body?.access_token !== 'string' || body.access_token === '') {
    throw new Error('Discord token exchange failed');
  }
  return body.access_token;
}

async function fetchCurrentUser(accessToken) {
  const response = await fetch(CURRENT_USER_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error('Discord profile lookup failed');
  }
  const profile = await response.json();
  if (!/^\d{16,22}$/.test(String(profile?.id || ''))) {
    throw new Error('Invalid Discord profile');
  }
  return profile;
}

async function checkGuildMembership(accessToken) {
  const { guildId } = requireConfig();
  const response = await fetch(
    `https://discord.com/api/v10/users/@me/guilds/${encodeURIComponent(
      guildId,
    )}/member`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  return response.ok;
}

function createState(payload) {
  const body = {
    ...payload,
    issuedAt: Date.now(),
    nonce: crypto.randomBytes(16).toString('hex'),
  };
  const encodedBody = base64UrlEncode(JSON.stringify(body));
  return `${encodedBody}.${sign(encodedBody)}`;
}

function verifyState(state) {
  if (typeof state !== 'string') {
    return null;
  }
  const [encodedBody, signature] = state.split('.');
  if (!encodedBody || !signature || !safeEqual(sign(encodedBody), signature)) {
    return null;
  }
  try {
    const body = JSON.parse(base64UrlDecode(encodedBody).toString('utf8'));
    if (
      typeof body.playerId !== 'string' ||
      typeof body.sessionId !== 'string' ||
      typeof body.redirectUri !== 'string' ||
      typeof body.issuedAt !== 'number' ||
      body.issuedAt > Date.now() ||
      Date.now() - body.issuedAt > STATE_TTL_MS
    ) {
      return null;
    }
    return body;
  } catch {
    return null;
  }
}

function getRedirectUri(origin) {
  const { redirectUri } = requireConfig();
  return redirectUri || `${origin}${CALLBACK_PATH}`;
}

function createFrontendRedirect(pathname) {
  const baseUrl = String(process.env.BATTLECITY_WEB_BASE_URL || '').trim();
  return baseUrl === ''
    ? pathname
    : new URL(pathname, `${baseUrl.replace(/\/+$/, '')}/`).toString();
}

function redirectResponse(location, status = 302) {
  return new Response(null, { status, headers: { location } });
}

function requireConfig() {
  if (!isConfigured()) {
    throw new Error('Discord OAuth is not configured');
  }
  return getConfig();
}

function sign(value) {
  return base64UrlEncode(
    crypto
      .createHmac('sha256', requireConfig().stateSecret)
      .update(value)
      .digest(),
  );
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function base64UrlEncode(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(`${normalized}${padding}`, 'base64');
}

module.exports = {
  CALLBACK_PATH,
  completeVerification,
  createAuthorizationUrl,
  createFrontendRedirect,
  getRedirectUri,
  isConfigured,
  redirectResponse,
};
