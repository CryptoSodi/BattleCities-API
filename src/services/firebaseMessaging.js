const crypto = require('node:crypto');
const { normalizeNotification, isValidToken } = require('./notificationPayload');

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const PROJECT_ID = 'battle-cities-84acd';
const ANDROID_PACKAGE = 'com.battlecities.game';

let accessToken = null;
let tokenRequest = null;
let serviceAccount = null;
let credentialFingerprint = null;

async function sendToToken(token, payload) {
  if (!isValidToken(token)) {
    throw new Error('A Firebase device token is required');
  }

  const data = normalizeNotification(payload);
  const credentials = getServiceAccount();
  for (let attempt = 0; attempt < 2; attempt++) {
    const bearer = await getAccessToken(credentials);
    let response;
    try {
      response = await fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          message: {
            token,
            data,
            android: {
              priority: 'HIGH',
              restricted_package_name: ANDROID_PACKAGE,
            },
          },
        }),
      });
    } catch {
      throw messagingError('Firebase messaging request failed', 'FCM_NETWORK_ERROR');
    }
    const body = await response.json().catch(() => null);
    if (response.ok) return body;
    if (response.status === 401 && attempt === 0) {
      if (accessToken?.value === bearer) accessToken = null;
      continue;
    }
    const details = Array.isArray(body?.error?.details) ? body.error.details : [];
    const fcmCode = details.find((detail) => detail?.['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError')?.errorCode;
    const tokenViolation = details.some((detail) => detail?.['@type'] === 'type.googleapis.com/google.rpc.BadRequest'
      && detail.fieldViolations?.some((violation) => violation.field === 'message.token'));
    const explicitlyInvalidToken = fcmCode === 'INVALID_ARGUMENT'
      && /registration token/i.test(String(body?.error?.message || ''))
      && /invalid|not.*valid/i.test(String(body?.error?.message || ''));
    const error = messagingError('Firebase messaging request failed', 'FCM_SEND_FAILED');
    error.status = response.status;
    error.invalidToken = fcmCode === 'UNREGISTERED'
      || (response.status === 400 && (tokenViolation || explicitlyInvalidToken));
    // Provider bodies may echo device tokens or submitted data. Keep them out of errors/logs.
    throw error;
  }
}

function isConfigured() {
  try { getServiceAccount(); return true; } catch { return false; }
}

function getServiceAccount() {
  const value = getServiceAccountValue();
  const fingerprint = crypto.createHash('sha256').update(value).digest('hex');
  if (serviceAccount !== null && fingerprint === credentialFingerprint) {
    return serviceAccount;
  }
  if (!value) {
    throw messagingError('Firebase messaging is not configured', 'FIREBASE_NOT_CONFIGURED');
  }

  try {
    const parsed = JSON.parse(value);
    if (
      parsed?.project_id !== PROJECT_ID ||
      typeof parsed?.client_email !== 'string' || !parsed.client_email.trim() ||
      typeof parsed?.private_key !== 'string' ||
      crypto.createPrivateKey(parsed.private_key).asymmetricKeyType !== 'rsa'
    ) {
      throw new Error();
    }
    serviceAccount = parsed;
    credentialFingerprint = fingerprint;
    accessToken = null;
    return serviceAccount;
  } catch {
    throw messagingError('Firebase credentials must be a valid service account for battle-cities-84acd', 'FIREBASE_NOT_CONFIGURED');
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
  try { return await tokenRequest; }
  catch { throw messagingError('Firebase service-account authentication failed', 'FIREBASE_AUTH_FAILED'); }
  finally { tokenRequest = null; }
}

function messagingError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  isConfigured,
  sendToToken,
  PROJECT_ID,
  ANDROID_PACKAGE,
};
