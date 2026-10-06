const crypto = require('node:crypto');

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

let accessToken = null;
let tokenRequest = null;
let serviceAccount = null;

async function sendToToken(token, payload) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('A Firebase device token is required');
  }

  const credentials = getServiceAccount();
  const bearer = await getAccessToken(credentials);
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${credentials.project_id}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      message: {
        token,
        data: {
          title: normalizeText(payload.title, 'Battle Cities'),
          body: normalizeText(payload.body, 'You have a new update.'),
          route: normalizeText(payload.route, '/'),
          type: normalizeText(payload.type, 'announcement'),
          imageUrl: normalizeText(payload.imageUrl, ''),
          externalUrl: normalizeText(payload.externalUrl, ''),
          actionLabel: normalizeText(payload.actionLabel, ''),
        },
        android: {
          priority: 'high',
          notification: {
            channel_id: 'battle-cities-notifications',
          },
        },
      },
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error('Firebase messaging request failed');
    error.response = { data: body, status: response.status };
    if (response.status === 401) accessToken = null;
    throw error;
  }
  return body;
}

function isConfigured() {
  return getServiceAccountValue() !== '';
}

function getServiceAccount() {
  if (serviceAccount !== null) {
    return serviceAccount;
  }
  if (!isConfigured()) {
    throw new Error('Firebase messaging is not configured');
  }

  try {
    const parsed = JSON.parse(getServiceAccountValue());
    if (
      typeof parsed?.project_id !== 'string' ||
      typeof parsed?.client_email !== 'string' ||
      typeof parsed?.private_key !== 'string'
    ) {
      throw new Error('Firebase service account is incomplete');
    }
    serviceAccount = parsed;
    return serviceAccount;
  } catch (error) {
    throw new Error(
      `Firebase service account is invalid: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

function getServiceAccountValue() {
  const encoded = String(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '').trim();
  if (encoded !== '') {
    return Buffer.from(encoded, 'base64').toString('utf8');
  }
  return String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
}

// Firebase service-account authentication, independent of player login.
// https://developers.google.com/identity/protocols/oauth2/service-account
async function getAccessToken(credentials) {
  if (accessToken && accessToken.expiresAt > Date.now() + 60000) return accessToken.value;
  if (tokenRequest) return tokenRequest;
  tokenRequest = (async () => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = { alg: 'RS256', typ: 'JWT' };
    if (credentials.private_key_id) header.kid = credentials.private_key_id;
    const unsigned = `${encode(header)}.${encode({ iss: credentials.client_email,
      scope: FCM_SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: issuedAt, exp: issuedAt + 3600 })}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), credentials.private_key).toString('base64url');
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    });
    const body = await response.json();
    if (!response.ok || typeof body.access_token !== 'string' || !(Number(body.expires_in) > 0)) {
      throw new Error('Firebase service-account authentication failed');
    }
    accessToken = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in) * 1000 };
    return accessToken.value;
  })();
  try { return await tokenRequest; } finally { tokenRequest = null; }
}

function normalizeText(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

module.exports = {
  isConfigured,
  sendToToken,
};
