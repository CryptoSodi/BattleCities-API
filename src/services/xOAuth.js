const crypto = require('crypto');

const AUTHORIZATION_URL = 'https://x.com/i/oauth2/authorize';
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const CURRENT_USER_URL = 'https://api.x.com/2/users/me?user.fields=username';
const CALLBACK_PATH = '/api/integrations/x/oauth/callback';
const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_VERSION = 1;
// X accepts OAuth state values up to 500 characters. Keep the verifier at the
// PKCE minimum (43 base64url characters) so the encrypted state stays below
// that limit for real Battle Cities player IDs.
const MAX_STATE_LENGTH = 500;
const MAX_CODE_LENGTH = 2048;
const BATTLECITIES_X_USER_ID = '2070252693130731520';

function getConfig() {
  return {
    clientId: String(process.env.X_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.X_CLIENT_SECRET || '').trim(),
    bearerToken: String(process.env.X_BEARER_TOKEN || '').trim(),
    redirectUri: String(process.env.X_OAUTH_REDIRECT_URI || '').trim(),
    stateSecret: String(process.env.X_OAUTH_STATE_SECRET || '').trim(),
    targetUserId: String(
      process.env.X_BATTLECITIES_USER_ID || BATTLECITIES_X_USER_ID,
    ).trim(),
    targetUsername: String(
      process.env.X_BATTLECITIES_USERNAME || 'BattleCitiesHQ',
    ).trim().replace(/^@/, ''),
  };
}

function isConfigured() {
  const config = getConfig();
  return (
    config.clientId !== '' &&
    config.clientSecret !== '' &&
    config.bearerToken !== '' &&
    Buffer.byteLength(config.stateSecret, 'utf8') >= 32 &&
    isValidRedirectUri(config.redirectUri) &&
    (config.targetUserId !== ''
      ? /^\d{1,20}$/.test(config.targetUserId)
      : /^[A-Za-z0-9_]{1,15}$/.test(config.targetUsername))
  );
}

function createAuthorizationUrl(origin, playerId, sessionId) {
  const config = requireConfig();
  const redirectUri = getRedirectUri(origin);
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: 'tweet.read users.read follows.read',
    state: createState({
      playerId,
      sessionBinding: createSessionBinding(sessionId),
      redirectUri,
      codeVerifier,
    }),
    code_challenge: crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url'),
    code_challenge_method: 'S256',
  });
  return `${AUTHORIZATION_URL}?${params.toString()}`;
}

async function completeConnection({ code, state, sessionId }) {
  if (typeof code !== 'string' || code.length < 1 || code.length > MAX_CODE_LENGTH) {
    throw new Error('Invalid X authorization code');
  }
  const statePayload = verifyState(state);
  if (
    statePayload === null ||
    !safeEqual(statePayload.sessionBinding, createSessionBinding(sessionId))
  ) {
    throw new Error('Invalid X OAuth state');
  }
  const accessToken = await exchangeCode(
    code,
    statePayload.redirectUri,
    statePayload.codeVerifier,
  );
  return { playerId: statePayload.playerId, profile: await fetchCurrentUser(accessToken) };
}

async function checkFollowsBattleCities(xUserId) {
  if (!/^\d{1,20}$/.test(String(xUserId || ''))) {
    throw new Error('Invalid X account');
  }
  const targetUserId = await getTargetUserId();
  let paginationToken = null;
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`https://api.x.com/2/users/${encodeURIComponent(xUserId)}/following`);
    url.searchParams.set('max_results', '1000');
    if (paginationToken !== null) url.searchParams.set('pagination_token', paginationToken);
    const response = await xApi(url);
    if ((response.data || []).some(user => user.id === targetUserId)) return true;
    paginationToken = response.meta?.next_token || null;
    if (paginationToken === null) return false;
  }
  throw new Error('X follow verification reached its safe page limit');
}

async function exchangeCode(code, redirectUri, codeVerifier) {
  const config = requireConfig();
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(
        `${config.clientId}:${config.clientSecret}`,
        'utf8',
      ).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) throw new Error('X token exchange failed');
  const body = await response.json();
  if (typeof body?.access_token !== 'string' || body.access_token === '') {
    throw new Error('X token exchange failed');
  }
  return body.access_token;
}

async function fetchCurrentUser(accessToken) {
  const response = await fetch(CURRENT_USER_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error('X profile lookup failed');
  const profile = (await response.json()).data;
  if (!/^\d{1,20}$/.test(String(profile?.id || '')) || !/^[A-Za-z0-9_]{1,15}$/.test(String(profile?.username || ''))) {
    throw new Error('Invalid X profile');
  }
  return profile;
}

async function getTargetUserId() {
  const config = requireConfig();
  if (config.targetUserId !== '') return config.targetUserId;
  const result = await xApi(
    `https://api.x.com/2/users/by/username/${encodeURIComponent(config.targetUsername)}`,
  );
  if (!/^\d{1,20}$/.test(String(result.data?.id || ''))) {
    throw new Error('BattleCities X account lookup failed');
  }
  return result.data.id;
}

async function xApi(url) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${requireConfig().bearerToken}` },
  });
  if (!response.ok) {
    // X can return useful error titles such as "Unauthorized" or
    // "Usage cap exceeded". Keep that diagnostic, but never log its body,
    // request URL, or authorization header because those could contain
    // sensitive account information.
    const body = await response.json().catch(() => null);
    const title = typeof body?.title === 'string'
      ? body.title.replace(/[^a-z0-9 -]/gi, '').slice(0, 80)
      : 'request failed';
    throw new Error(`X follow verification failed (${response.status}: ${title})`);
  }
  return response.json();
}

function createState(payload) {
  const body = {
    v: STATE_VERSION,
    ...payload,
    issuedAt: Date.now(),
    nonce: crypto.randomBytes(16).toString('hex'),
  };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getStateEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(body), 'utf8'),
    cipher.final(),
  ]);
  return [
    base64UrlEncode(iv),
    base64UrlEncode(ciphertext),
    base64UrlEncode(cipher.getAuthTag()),
  ].join('.');
}

function verifyState(state) {
  if (typeof state !== 'string' || state.length > MAX_STATE_LENGTH) return null;
  const parts = state.split('.');
  if (parts.length !== 3 || parts.some((part) => part === '')) return null;
  try {
    const [encodedIv, encodedCiphertext, encodedTag] = parts;
    const iv = base64UrlDecode(encodedIv);
    const tag = base64UrlDecode(encodedTag);
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      getStateEncryptionKey(),
      iv,
    );
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(base64UrlDecode(encodedCiphertext)),
      decipher.final(),
    ]);
    const body = JSON.parse(plaintext.toString('utf8'));
    if (
      body.v !== STATE_VERSION ||
      typeof body.playerId !== 'string' ||
      typeof body.sessionBinding !== 'string' ||
      typeof body.redirectUri !== 'string' ||
      typeof body.codeVerifier !== 'string' ||
      typeof body.issuedAt !== 'number' ||
      body.issuedAt > Date.now() ||
      Date.now() - body.issuedAt > STATE_TTL_MS
    ) return null;
    return body;
  } catch {
    return null;
  }
}

function getRedirectUri(origin) {
  const { redirectUri } = requireConfig();
  return redirectUri || `${origin}${CALLBACK_PATH}`;
}

function isValidRedirectUri(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.pathname === CALLBACK_PATH;
  } catch {
    return false;
  }
}

function createFrontendRedirect(pathname) {
  // X connection belongs to the public site. Keep this separate from the
  // game-wide OAuth return URL, which is also used by Google and Discord.
  const baseUrl = String(
    process.env.BATTLECITY_X_WEB_BASE_URL || process.env.BATTLECITY_WEB_BASE_URL || '',
  ).trim();
  return baseUrl === '' ? pathname : new URL(pathname, `${baseUrl.replace(/\/+$/, '')}/`).toString();
}

function redirectResponse(location) {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

function requireConfig() {
  if (!isConfigured()) throw new Error('X OAuth is not configured');
  return getConfig();
}

function getStateEncryptionKey() {
  return crypto
    .createHash('sha256')
    .update(requireConfig().stateSecret, 'utf8')
    .digest();
}

function createSessionBinding(sessionId) {
  return crypto
    .createHmac('sha256', requireConfig().stateSecret)
    .update(`session:${sessionId}`, 'utf8')
    .digest('base64url');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(value, 'base64url');
}

module.exports = {
  CALLBACK_PATH,
  checkFollowsBattleCities,
  completeConnection,
  createAuthorizationUrl,
  createFrontendRedirect,
  isConfigured,
  redirectResponse,
};
