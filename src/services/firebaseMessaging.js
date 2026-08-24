const { GoogleAuth } = require('google-auth-library');

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

let authClient = null;
let serviceAccount = null;

async function sendToToken(token, payload) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('A Firebase device token is required');
  }

  const credentials = getServiceAccount();
  const client = await getAuthClient(credentials);
  const response = await client.request({
    url: `https://fcm.googleapis.com/v1/projects/${credentials.project_id}/messages:send`,
    method: 'POST',
    data: {
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
    },
  });
  return response.data;
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

async function getAuthClient(credentials) {
  if (authClient === null) {
    const auth = new GoogleAuth({ credentials, scopes: [FCM_SCOPE] });
    authClient = await auth.getClient();
  }
  return authClient;
}

function normalizeText(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

module.exports = {
  isConfigured,
  sendToToken,
};
