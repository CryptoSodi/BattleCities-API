const crypto = require('crypto');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const CALLBACK_PATH = '/api/auth/google/callback';
const STATE_TTL_MS = 10 * 60 * 1000;

function getConfig() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    stateSecret:
      process.env.GOOGLE_OAUTH_STATE_SECRET ||
      process.env.GOOGLE_CLIENT_SECRET ||
      '',
  };
}

function isConfigured() {
  const config = getConfig();
  return (
    config.clientId !== '' &&
    config.clientSecret !== '' &&
    config.stateSecret !== ''
  );
}

function createAuthorizationUrl(origin) {
  const config = requireConfig();
  const redirectUri = createRedirectUri(origin);
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    include_granted_scopes: 'true',
    prompt: 'select_account',
    state: createState({ redirectUri }),
  });

  return `${AUTH_URL}?${params.toString()}`;
}

async function completeLogin({ code, state }) {
  const statePayload = verifyState(state);
  if (statePayload === null) {
    throw new Error('Invalid Google state');
  }

  const tokenResponse = await exchangeCode(code, statePayload.redirectUri);
  const profile = await fetchProfile(tokenResponse.access_token);

  return {
    profile,
    redirectUri: statePayload.redirectUri,
  };
}

async function completeNativeLogin(idToken) {
  if (typeof idToken !== 'string' || idToken.length < 100 || idToken.length > 10000) {
    throw new Error('Invalid Google ID token');
  }

  const config = requireConfig();
  const { OAuth2Client } = require('google-auth-library');
  const client = new OAuth2Client(config.clientId);
  const ticket = await client.verifyIdToken({
    idToken,
    audience: config.clientId,
  });
  const payload = ticket.getPayload();

  if (
    payload === undefined ||
    typeof payload.sub !== 'string' ||
    payload.sub === '' ||
    payload.email_verified !== true
  ) {
    throw new Error('Invalid Google identity');
  }

  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    name: typeof payload.name === 'string' ? payload.name : null,
    picture: typeof payload.picture === 'string' ? payload.picture : null,
  };
}

async function exchangeCode(code, redirectUri) {
  const config = requireConfig();
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    throw new Error('Google token exchange failed');
  }

  return response.json();
}

async function fetchProfile(accessToken) {
  const response = await fetch(USERINFO_URL, {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error('Google profile fetch failed');
  }

  const profile = await response.json();
  if (typeof profile.sub !== 'string' || profile.sub === '') {
    throw new Error('Invalid Google profile');
  }

  return profile;
}

function createState(payload) {
  const body = {
    ...payload,
    issuedAt: Date.now(),
    nonce: crypto.randomBytes(16).toString('hex'),
  };
  const encodedBody = base64UrlEncode(JSON.stringify(body));
  const signature = sign(encodedBody);

  return `${encodedBody}.${signature}`;
}

function verifyState(state) {
  if (typeof state !== 'string') {
    return null;
  }

  const [encodedBody, signature] = state.split('.');
  if (!encodedBody || !signature || sign(encodedBody) !== signature) {
    return null;
  }

  try {
    const body = JSON.parse(base64UrlDecode(encodedBody).toString('utf8'));
    if (
      typeof body.redirectUri !== 'string' ||
      typeof body.issuedAt !== 'number' ||
      Date.now() - body.issuedAt > STATE_TTL_MS
    ) {
      return null;
    }

    return body;
  } catch {
    return null;
  }
}

function sign(value) {
  return base64UrlEncode(
    crypto.createHmac('sha256', requireConfig().stateSecret).update(value).digest(),
  );
}

function createRedirectUri(origin) {
  return `${origin}${CALLBACK_PATH}`;
}

function getOriginFromRequestUrl(requestUrl) {
  return new URL(requestUrl).origin;
}

function getOriginFromExpressRequest(request) {
  const proto =
    request.headers['x-forwarded-proto'] ||
    (request.connection?.encrypted ? 'https' : request.protocol || 'http');
  const host = request.headers['x-forwarded-host'] || request.headers.host;

  return `${String(proto).split(',')[0]}://${String(host).split(',')[0]}`;
}

function redirectResponse(location, status = 302) {
  return new Response(null, {
    status,
    headers: {
      location,
    },
  });
}

function createFrontendRedirect(pathname) {
  const baseUrl = String(process.env.BATTLECITY_WEB_BASE_URL || '').trim();
  if (baseUrl === '') {
    return pathname;
  }

  return new URL(pathname, `${baseUrl.replace(/\/+$/, '')}/`).toString();
}

function requireConfig() {
  const config = getConfig();
  if (!isConfigured()) {
    throw new Error('Google OAuth is not configured');
  }

  return config;
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
  completeLogin,
  completeNativeLogin,
  createAuthorizationUrl,
  createFrontendRedirect,
  createRedirectUri,
  getOriginFromExpressRequest,
  getOriginFromRequestUrl,
  isConfigured,
  redirectResponse,
};
