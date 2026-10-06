import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import test, { beforeEach, afterEach } from 'node:test';

const require = createRequire(import.meta.url);
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const credentials = { project_id: 'battle-cities-84acd', client_email: 'service@example.test',
  private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }), private_key_id: 'test-key' };
const token = 'test-device-token-1234567890';
const payload = { title: 'Title', body: 'Body', route: 'shop', type: 'reward' };
let messaging;
let previous;
beforeEach(() => {
  previous = { json: process.env.FIREBASE_SERVICE_ACCOUNT_JSON, base64: process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 };
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify(credentials);
  delete process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  delete require.cache[require.resolve('../src/services/firebaseMessaging')];
  messaging = require('../src/services/firebaseMessaging');
});
afterEach(() => {
  for (const [key, value] of [['FIREBASE_SERVICE_ACCOUNT_JSON', previous.json], ['FIREBASE_SERVICE_ACCOUNT_BASE64', previous.base64]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('credentials support base64, reject wrong projects and never echo invalid secret JSON', async (t) => {
  process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 = Buffer.from(JSON.stringify(credentials)).toString('base64');
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = 'ignored-invalid-json';
  assert.equal(messaging.isConfigured(), true);
  delete process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ ...credentials, project_id: 'wrong-project' });
  assert.equal(messaging.isConfigured(), false);
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = 'private-credential-fragment-not-json';
  t.mock.method(globalThis, 'fetch', () => { throw new Error('No network calls expected'); });
  await assert.rejects(messaging.sendToToken(token, payload), (error) => {
    assert.equal(error.code, 'FIREBASE_NOT_CONFIGURED');
    assert.equal(String(error).includes('private-credential-fragment'), false); return true;
  });
  assert.equal(globalThis.fetch.mock.calls.length, 0);
});

test('401 refreshes authentication once; provider error bodies stay out of thrown errors', async (t) => {
  let exchanges = 0; let sends = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.includes('oauth2.googleapis.com')) return Response.json({ access_token: `access-${++exchanges}`, expires_in: 3600 });
    sends++;
    assert.equal(init.headers.authorization, `Bearer access-${exchanges}`);
    return sends === 1 ? Response.json({ error: { message: `secret ${token}` } }, { status: 401 }) : Response.json({ name: 'sent' });
  });
  assert.deepEqual(await messaging.sendToToken(token, payload), { name: 'sent' });
  assert.equal(exchanges, 2); assert.equal(sends, 2);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: `secret ${token}` } }, { status: 403 }));
  await assert.rejects(messaging.sendToToken(token, payload), (error) => {
    assert.equal(error.status, 403); assert.equal(error.invalidToken, false);
    assert.equal(error.response, undefined); assert.equal(String(error).includes(token), false); return true;
  });
});

test('only token-specific permanent errors mark a device invalid', async (t) => {
  const fcm = (errorCode) => ({ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode });
  const cases = [
    [404, { status: 'NOT_FOUND', details: [fcm('UNREGISTERED')] }, true],
    [400, { message: 'Invalid registration token supplied', details: [fcm('INVALID_ARGUMENT')] }, true],
    [400, { details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'message.token' }] }] }, true],
    [400, { details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'message.data[0].value' }] }] }, false],
    [400, { message: 'Invalid package', details: [fcm('INVALID_ARGUMENT')] }, false],
    [403, { details: [fcm('SENDER_ID_MISMATCH')] }, false],
    [429, { details: [fcm('QUOTA_EXCEEDED')] }, false],
    [503, { details: [fcm('UNAVAILABLE')] }, false],
    [404, { status: 'NOT_FOUND' }, false],
  ];
  let current;
  t.mock.method(globalThis, 'fetch', async (url) => url.includes('oauth2.googleapis.com')
    ? Response.json({ access_token: 'test-access', expires_in: 3600 })
    : Response.json({ error: current[1] }, { status: current[0] }));
  for (current of cases) await assert.rejects(messaging.sendToToken(token, payload), (error) => {
    assert.equal(error.invalidToken, current[2], JSON.stringify(current)); return true;
  });
});

test('payloads support Unity routes, legacy message text and safe HTTPS actions', async (t) => {
  const sends = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'test-access', expires_in: 3600 });
    const message = JSON.parse(init.body).message;
    assert.equal(message.notification, undefined); assert.equal(message.android.notification, undefined);
    assert.ok(Object.values(message.data).every((value) => typeof value === 'string'));
    sends.push(message.data); return Response.json({ name: 'sent' });
  });
  for (const route of ['home', 'play', 'shop', 'rewards', 'social', 'external', 'share', 'unknown']) {
    await messaging.sendToToken(token, { title: 'Title', message: 'Legacy message', route,
      externalUrl: 'https://battlecities.com', imageUrl: 'https://example.test/image.png', actionLabel: 'Open' });
    assert.equal(sends.at(-1).route, route === 'unknown' ? 'home' : route);
    assert.equal(sends.at(-1).body, 'Legacy message'); assert.equal(sends.at(-1).externalUrl, 'https://battlecities.com/');
  }
  const failures = [
    { title: '' }, { title: 'x'.repeat(81) }, { body: 'x'.repeat(241) }, { body: 12 },
    { actionLabel: 'x'.repeat(33) }, { route: 'x'.repeat(33) }, { type: 'test' },
    { imageUrl: 'http://example.test/image.png' }, { imageUrl: 'https://user:password@example.test/a' },
    { externalUrl: 'javascript:alert(1)' }, { route: 'external', externalUrl: '' },
    { imageUrl: 'https://example.test/' + 'x'.repeat(2048) },
    { imageUrl: 'https://example.test/' + 'x'.repeat(1990), externalUrl: 'https://example.test/' + 'x'.repeat(1990) },
  ];
  const originalCount = sends.length;
  for (const failure of failures) await assert.rejects(messaging.sendToToken(token, { ...payload, ...failure }), { code: 'INVALID_NOTIFICATION' });
  assert.equal(sends.length, originalCount);
});

test('network and OAuth failures expose no secrets and do not invalidate devices', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error(`secret-provider-error-${token}`); });
  await assert.rejects(messaging.sendToToken(token, payload), (error) => {
    assert.equal(error.code, 'FIREBASE_AUTH_FAILED'); assert.equal(String(error).includes(token), false); return true;
  });
});
