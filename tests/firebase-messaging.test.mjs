import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
test('Firebase push keeps service-account JWT authentication and reuses its token', async (t) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test-project', client_email: 'service@example.test',
    private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }), private_key_id: 'test-key' });
  delete process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  let exchanges = 0; let sends = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      exchanges++;
      assert.equal(init.body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const [header, claims, signature] = init.body.get('assertion').split('.');
      assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');
      const payload = JSON.parse(Buffer.from(claims, 'base64url'));
      assert.equal(payload.iss, 'service@example.test'); assert.equal(payload.exp - payload.iat, 3600);
      assert.equal(payload.aud, url); assert.match(payload.scope, /firebase.messaging$/);
      assert.equal(crypto.verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url')), true);
      return Response.json({ access_token: 'test-access', expires_in: 3600 });
    }
    sends++; assert.equal(url, 'https://fcm.googleapis.com/v1/projects/test-project/messages:send');
    assert.equal(init.headers.authorization, 'Bearer test-access');
    assert.equal(JSON.parse(init.body).message.token, 'test-device');
    return Response.json({ name: 'projects/test-project/messages/one' });
  });
  const messaging = require('../src/services/firebaseMessaging');
  await Promise.all([messaging.sendToToken('test-device', { title: 'Title' }), messaging.sendToToken('test-device', { title: 'Title' })]);
  assert.equal(exchanges, 1); assert.equal(sends, 2);
});
