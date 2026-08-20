import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const xOAuth = require('../src/services/xOAuth.js');

const TEST_ENV = {
  X_CLIENT_ID: 'test-client-id',
  X_CLIENT_SECRET: 'test-client-secret',
  X_BEARER_TOKEN: 'test-app-bearer-token',
  X_OAUTH_STATE_SECRET: 'a'.repeat(64),
  X_OAUTH_REDIRECT_URI: 'https://api.battlecities.com/api/integrations/x/oauth/callback',
  X_BATTLECITIES_USERNAME: 'BattleCitiesHQ',
};

test('X OAuth keeps session and PKCE values opaque and uses confidential-client auth', async () => {
  await withTestEnv(async () => {
    const sessionId = 'session-secret-that-must-not-leak';
    const playerId = 'ply-msalfmd1-f146c7fd0bbe5cbd8410';
    const authorizationUrl = new URL(
      xOAuth.createAuthorizationUrl(
        'https://api.battlecities.com',
        playerId,
        sessionId,
      ),
    );
    const state = authorizationUrl.searchParams.get('state');
    assert.ok(state);
    assert.ok(state.length <= 500);
    assert.equal(state.includes(sessionId), false);
    assert.equal(state.split('.').length, 3);
    assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(
      authorizationUrl.searchParams.get('scope'),
      'tweet.read users.read follows.read',
    );

    const requests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith('/2/oauth2/token')) {
        return Response.json({ access_token: 'user-access-token' });
      }
      return Response.json({ data: { id: '123456789', username: 'BattlePlayer' } });
    };
    try {
      const completed = await xOAuth.completeConnection({
        code: 'authorization-code',
        state,
        sessionId,
      });
      assert.equal(completed.playerId, playerId);
      assert.equal(completed.profile.id, '123456789');
    } finally {
      globalThis.fetch = originalFetch;
    }

    const tokenRequest = requests[0];
    const expectedBasic = Buffer.from('test-client-id:test-client-secret').toString('base64');
    assert.equal(tokenRequest.options.headers.authorization, `Basic ${expectedBasic}`);
    assert.equal(String(tokenRequest.options.body).includes('client_secret'), false);
    assert.equal(requests[1].options.headers.authorization, 'Bearer user-access-token');
  });
});

test('X OAuth rejects state tampering, session swapping, weak secrets, and unsafe callbacks', async () => {
  await withTestEnv(async () => {
    const authorizationUrl = new URL(
      xOAuth.createAuthorizationUrl('https://api.battlecities.com', 'ply-test', 'session-one'),
    );
    const state = authorizationUrl.searchParams.get('state');
    await assert.rejects(
      xOAuth.completeConnection({ code: 'code', state: `${state}x`, sessionId: 'session-one' }),
      /Invalid X OAuth state/,
    );
    await assert.rejects(
      xOAuth.completeConnection({ code: 'code', state, sessionId: 'session-two' }),
      /Invalid X OAuth state/,
    );

    process.env.X_OAUTH_STATE_SECRET = 'short';
    assert.equal(xOAuth.isConfigured(), false);
    process.env.X_OAUTH_STATE_SECRET = TEST_ENV.X_OAUTH_STATE_SECRET;
    process.env.X_OAUTH_REDIRECT_URI = 'http://api.battlecities.com/api/integrations/x/oauth/callback';
    assert.equal(xOAuth.isConfigured(), false);
  });
});

async function withTestEnv(operation) {
  const original = new Map();
  for (const [key, value] of Object.entries(TEST_ENV)) {
    original.set(key, process.env[key]);
    process.env[key] = value;
  }
  original.set('X_BATTLECITIES_USER_ID', process.env.X_BATTLECITIES_USER_ID);
  delete process.env.X_BATTLECITIES_USER_ID;
  try {
    await operation();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
