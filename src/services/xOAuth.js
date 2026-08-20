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
const CONNECTION_PURPOSE = 'connect';
const FOLLOW_VERIFICATION_PURPOSE = 'verify-follow';

function getConfig() {
  return {
    clientId: String(process.env.X_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.X_CLIENT_SECRET || '').trim(),
    redirectUri: String(process.env.X_OAUTH_REDIRECT_URI || '').trim(),
    stateSecret: String(process.env.X_OAUTH_STATE_SECRET || '').trim(),
    targetUserId: String(
      process.env.X_BATTLECITIES_USER_ID || BATTLECITIES_X_USER_ID,
    ).trim(),
  };
}

function isConfigured() {
  const config = getConfig();
  return (
    config.clientId !== '' &&
    config.clientSecret !== '' &&
    Buffer.byteLength(config.stateSecret, 'utf8') >= 32 &&
    isValidRedirectUri(config.redirectUri) &&
    /^\d{1,20}$/.test(config.targetUserId)
  );
}

function createAuthorizationUrl(origin, playerId, sessionId, purpose = CONNECTION_PURPOSE) {
  const config = requireConfig();
  if (!isSupportedPurpose(purpose)) throw new Error('Invalid X OAuth purpose');
  const redirectUri = getRedirectUri(origin);
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: 'tweet.read tweet.write users.read follows.read',
    state: createState({
      playerId,
      sessionBinding: createSessionBinding(sessionId),
      redirectUri,
      codeVerifier,
      // X limits state values to 500 characters; compact purpose markers keep
      // the encrypted, session-bound state within that limit.
      purpose: purpose === 'repost' ? 'r' : purpose === FOLLOW_VERIFICATION_PURPOSE ? 'f' : undefined,
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
  return {
    playerId: statePayload.playerId,
    purpose: statePayload.purpose === 'r'
      ? 'repost'
      : statePayload.purpose === 'f'
        ? FOLLOW_VERIFICATION_PURPOSE
        : CONNECTION_PURPOSE,
    profile: await fetchCurrentUser(accessToken),
    // This is intentionally returned only to the OAuth callback. It is never
    // persisted, sent to the browser, or logged.
    accessToken,
  };
}

async function repostWithUserToken(accessToken, userId, postId) {
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new Error('Invalid X user access token');
  }
  if (!/^\d{1,20}$/.test(String(userId)) || !/^\d{1,20}$/.test(String(postId))) {
    throw new Error('Invalid X repost target');
  }
  const response = await fetch(
    `https://api.x.com/2/users/${encodeURIComponent(userId)}/retweets`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tweet_id: postId }),
    },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.data?.retweeted !== true) {
    throw new Error('X repost was not confirmed');
  }
}

async function verifyFollowWithUserToken(accessToken) {
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new Error('Invalid X user access token');
  }
  const { targetUserId } = requireConfig();
  // One user resource, with the authenticated user's relationship to it. Do
  // not use paginated followers/following lists: X bills those per returned
  // account and they are unsuitable for a reward verification flow.
  const url = new URL(`https://api.x.com/2/users/${encodeURIComponent(targetUserId)}`);
  url.searchParams.set('user.fields', 'connection_status');
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw await createXApiError(response, 'X relationship verification failed');
  const body = await response.json();
  return Array.isArray(body?.data?.connection_status)
    && body.data.connection_status.includes('following');
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

async function createXApiError(response, prefix) {
  // Preserve only a short, sanitized upstream status for operations. Never
  // emit the body, URL, or authorization header.
  const body = await response.json().catch(() => null);
  const title = typeof body?.title === 'string'
    ? body.title.replace(/[^a-z0-9 -]/gi, '').slice(0, 80)
    : 'request failed';
  return new Error(`${prefix} (${response.status}: ${title})`);
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
      // Accept the full legacy value briefly for in-flight states created by
      // the previous deployment; new states use a compact marker.
      (body.purpose !== undefined && body.purpose !== 'r' && body.purpose !== 'f' && !isSupportedPurpose(body.purpose)) ||
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

function isSupportedPurpose(value) {
  // Keep the OAuth state purpose explicit so future one-resource campaign
  // checks (post/reply verification) cannot accidentally enter this flow.
  return value === CONNECTION_PURPOSE
    || value === FOLLOW_VERIFICATION_PURPOSE
    || value === 'repost';
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
  CONNECTION_PURPOSE,
  completeConnection,
  createAuthorizationUrl,
  createFrontendRedirect,
  FOLLOW_VERIFICATION_PURPOSE,
  isConfigured,
  redirectResponse,
  verifyFollowWithUserToken,
  repostWithUserToken,
};
