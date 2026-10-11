import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import test, { beforeEach, afterEach } from 'node:test';

const require = createRequire(import.meta.url);
const app = require('../dist/src/app').default;
const devices = require('../dist/src/stores/pushDeviceStore');
const sessions = require('../dist/src/stores/sessionStore');
const bs58 = require('bs58').default;
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = { project_id: 'battle-cities-84acd', client_email: 'service@example.test',
  private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }) };
const adminWallet = '9YpW9nYJaUVhRwqWaJBBh9wkjCYh5RLr6krYvfr7GGKo';
const token = (name) => `test-device-${name}-1234567890`;
const notice = { title: 'Update', message: 'An update is available.', route: 'shop', type: 'announcement' };
let root; let sends; let sendResponse; let previous;

beforeEach(async (t) => {
  previous = { ...process.env };
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'battlecities-push-routes-'));
  process.env.NODE_ENV = 'test'; process.env.BATTLECITY_STORAGE_MODE = 'local';
  for (const dir of ['PLAYER', 'SESSION', 'ECONOMY', 'LEDGER']) process.env[`BATTLECITY_${dir}_DIR`] = path.join(root, dir);
  process.env.BATTLECITY_PUSH_DEVICE_FILE = path.join(root, 'devices.json');
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify(serviceAccount);
  delete process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  sends = []; sendResponse = async () => Response.json({ name: 'projects/battle-cities-84acd/messages/mock' });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'test-access', expires_in: 3600 });
    assert.equal(url, 'https://fcm.googleapis.com/v1/projects/battle-cities-84acd/messages:send');
    const message = JSON.parse(init.body).message;
    assert.equal(message.notification, undefined); assert.equal(message.android.notification, undefined);
    assert.equal(message.android.restricted_package_name, 'com.battlecities.game');
    assert.ok(Object.values(message.data).every((value) => typeof value === 'string'));
    sends.push(message); return sendResponse(message);
  });
});
afterEach(async () => {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('battlecities-push-routes-'));
  await fs.rm(resolved, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
});

function call(route, method = 'GET', body, cookie = '') {
  return app.fetch(new Request(`https://api.battlecities.com/api/${route}`, { method,
    headers: { 'content-type': 'application/json', cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}
const register = (value, permission = 'granted', cookie = '', extra = {}) =>
  call('notifications/devices', 'POST', { token: value, platform: 'android', permission, ...extra }, cookie);
async function guest() {
  const response = await call('session', 'POST', { provider: 'guest' });
  return { ...(await response.json()), cookie: response.headers.get('set-cookie').split(';')[0] };
}
async function wallet(address = bs58.encode(crypto.randomBytes(32))) {
  const session = await sessions.createWalletSession(address);
  return { ...session, cookie: `battlecity_session=${session.id}` };
}

test('registration owns devices by guest/wallet cookie, ignores playerId and clears ownership after logout', async () => {
  const one = await guest(); const two = await wallet(); const value = token('ownership');
  assert.equal((await register(value, 'granted', one.cookie, { playerId: two.playerId })).status, 201);
  assert.equal((await devices.listGrantedDevices(one.playerId)).length, 1);
  assert.equal((await devices.listGrantedDevices(two.playerId)).length, 0);
  assert.equal((await register(value, 'granted', two.cookie, { playerId: one.playerId })).status, 201);
  assert.equal((await devices.listGrantedDevices(one.playerId)).length, 0);
  assert.equal((await devices.listGrantedDevices(two.playerId)).length, 1);
  assert.equal((await call('session', 'DELETE', undefined, two.cookie)).status, 200);
  assert.deepEqual(await (await register(value, 'granted', '', { playerId: two.playerId })).json(), { ok: true });
  assert.equal((await devices.getGrantedDevice(value)).playerId, null);
  assert.equal((await devices.listGrantedDevices(two.playerId)).length, 0);
});

test('invalid registrations fail with 400; repeated registration stays idempotent and opt-out is filtered', async () => {
  for (const input of [null, [], {}, { token: 'tiny', platform: 'android', permission: 'granted' },
    { token: 'x'.repeat(2049), platform: 'android', permission: 'granted' },
    { token: token('spaces') + ' ', platform: 'android', permission: 'granted' },
    { token: token('bad-platform'), platform: 'ios', permission: 'granted' },
    { token: token('bad-permission'), platform: 'android', permission: 'unknown' }]) {
    assert.equal((await call('notifications/devices', 'POST', input)).status, 400);
  }
  const one = await guest(); const value = token('repeat');
  await register(value, 'granted', one.cookie); await register(value, 'granted', one.cookie);
  assert.equal(await devices.getGrantedDeviceCount(), 1);
  await register(value, 'denied', one.cookie);
  assert.equal(await devices.getGrantedDeviceCount(), 0);
  assert.equal((await devices.listGrantedDevices(one.playerId)).length, 0);
  assert.equal(JSON.parse(await fs.readFile(process.env.BATTLECITY_PUSH_DEVICE_FILE, 'utf8')).length, 1);
});

test('concurrent device registrations preserve every token and cleanup cannot delete a refreshed registration', async () => {
  await Promise.all(Array.from({ length: 30 }, (_, index) => register(token(`parallel-${index}`))));
  assert.equal(await devices.getGrantedDeviceCount(), 30);
  const value = token('refreshed'); await register(value);
  const old = await devices.getGrantedDevice(value); await register(value);
  assert.equal(await devices.removeInvalidDevice(value, old.lastSeenAt), false);
  const current = await devices.getGrantedDevice(value);
  assert.notEqual(current.lastSeenAt, old.lastSeenAt);
  assert.equal(await devices.removeInvalidDevice(value, current.lastSeenAt), true);
});

test('notification status and sending require an allowlisted wallet admin', async () => {
  const one = await guest(); const ordinary = await wallet();
  for (const cookie of ['', one.cookie, ordinary.cookie]) {
    const status = cookie ? 403 : 401;
    for (const [route, method] of [['admin/notifications', 'GET'], ['admin/notifications', 'POST'], ['admin/notifications/test', 'POST']]) {
      assert.equal((await call(route, method, method === 'POST' ? { audience: 'all', ...notice } : undefined, cookie)).status, status);
    }
  }
  const admin = await wallet(adminWallet); await register(token('count'), 'granted'); await register(token('denied'), 'denied');
  assert.deepEqual(await (await call('admin/notifications', 'GET', undefined, admin.cookie)).json(), {
    ok: true, configured: true, enabledDevices: 1,
    androidPackage: 'com.battlecities.game', firebaseProjectId: 'battle-cities-84acd',
  });
  assert.equal(sends.length, 0);
});

test('admin player delivery targets granted devices only and uses data-only Unity fields', async () => {
  const one = await guest(); const two = await wallet(); const admin = await wallet(adminWallet);
  await register(token('one'), 'granted', one.cookie); await register(token('opt-out'), 'denied', one.cookie);
  await register(token('other'), 'granted', two.cookie); await register(token('anonymous'));
  const response = await call('admin/notifications', 'POST', { audience: 'player', playerId: one.playerId,
    ...notice, imageUrl: 'https://example.test/image.png', actionLabel: 'Open' }, admin.cookie);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, sent: 1, failed: 0, removed: 0, skipped: 0, devices: 1 });
  assert.equal(sends[0].token, token('one')); assert.equal(sends[0].data.body, notice.message);
  assert.equal(sends[0].data.route, 'shop'); assert.equal(sends[0].data.imageUrl, 'https://example.test/image.png');
});

test('broadcast delivery includes enabled anonymous devices, filters other platforms and uses bounded batches', async () => {
  const admin = await wallet(adminWallet);
  await Promise.all(Array.from({ length: 31 }, (_, index) => register(token(`broadcast-${index}`))));
  await register(token('broadcast-denied'), 'denied');
  await devices.upsertDevice(null, { token: token('broadcast-ios'), permission: 'granted', platform: 'ios' });
  let active = 0; let peak = 0;
  sendResponse = async () => {
    peak = Math.max(peak, ++active); await new Promise(setImmediate); active--;
    return Response.json({ name: 'sent' });
  };
  const response = await call('admin/notifications', 'POST', { audience: 'all', ...notice }, admin.cookie);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, sent: 31, failed: 0, removed: 0, skipped: 0, devices: 31 });
  assert.equal(new Set(sends.map((entry) => entry.token)).size, 31);
  assert.ok(peak <= 25); assert.ok(peak > 1);
});

test('the test endpoint selects a registered player/device and never turns audience all into a broadcast', async () => {
  const one = await guest(); const admin = await wallet(adminWallet);
  await register(token('first'), 'granted', one.cookie); await register(token('second'), 'granted', one.cookie);
  assert.equal((await call('admin/notifications/test', 'POST', { token: token('first'), playerId: one.playerId }, admin.cookie)).status, 200);
  assert.deepEqual(sends.map((entry) => entry.token), [token('first')]);
  assert.equal(sends[0].data.route, 'home'); assert.equal(sends[0].data.type, 'announcement');
  assert.equal((await call('admin/notifications/test', 'POST', { audience: 'all' }, admin.cookie)).status, 400);
  assert.equal((await call('admin/notifications/test', 'POST', { token: token('missing') }, admin.cookie)).status, 404);
  assert.equal((await call('admin/notifications/test', 'POST', { token: token('first'), playerId: 'ply-other' }, admin.cookie)).status, 404);
  assert.equal(sends.length, 1);
  assert.equal((await call('admin/notifications/test', 'POST', { playerId: one.playerId }, admin.cookie)).status, 200);
  assert.equal(sends.length, 3);
});

test('invalid admin payloads return 400, missing credentials return 503, and unknown routes go home', async () => {
  const admin = await wallet(adminWallet); await register(token('validation'));
  for (const input of [null, [], { audience: 'all', ...notice, title: 'x'.repeat(81) },
    { audience: 'all', ...notice, imageUrl: 'http://example.test/image' },
    { audience: 'all', ...notice, route: 'external' }, { audience: 'player', ...notice, playerId: '../file' },
    { audience: 'all', ...notice, token: token('validation') }]) {
    assert.equal((await call('admin/notifications', 'POST', input, admin.cookie)).status, 400);
  }
  const malformed = new Request('https://api.battlecities.com/api/admin/notifications', {
    method: 'POST', body: '{broken', headers: { cookie: admin.cookie, 'content-type': 'application/json' } });
  assert.equal((await app.fetch(malformed)).status, 400);
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  assert.equal((await call('admin/notifications', 'POST', { audience: 'all', ...notice }, admin.cookie)).status, 503);
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify(serviceAccount);
  assert.equal((await call('admin/notifications', 'POST', { audience: 'device', token: token('validation'), ...notice, route: 'old-route' }, admin.cookie)).status, 200);
  assert.equal(sends.length, 1); assert.equal(sends[0].data.route, 'home');
});

test('rotated unregistered tokens are removed while new tokens and transient failures are retained', async () => {
  const one = await guest(); const admin = await wallet(adminWallet);
  for (const name of ['old', 'new', 'transient']) await register(token(name), 'granted', one.cookie);
  sendResponse = async (message) => {
    if (message.token === token('old')) return Response.json({ error: { details: [
      { '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' },
    ] } }, { status: 404 });
    if (message.token === token('transient')) return Response.json({ error: { status: 'UNAVAILABLE' } }, { status: 503 });
    return Response.json({ name: 'sent' });
  };
  const response = await call('admin/notifications', 'POST', { audience: 'player', playerId: one.playerId, ...notice }, admin.cookie);
  assert.deepEqual(await response.json(), { ok: true, sent: 1, failed: 2, removed: 1, skipped: 0, devices: 3 });
  assert.equal(await devices.getGrantedDevice(token('old')), null);
  assert.ok(await devices.getGrantedDevice(token('new'))); assert.ok(await devices.getGrantedDevice(token('transient')));
});

test('opt-out after audience selection prevents sending; refreshed ownership survives invalid-token cleanup', async (t) => {
  const one = await guest(); const two = await wallet(); const admin = await wallet(adminWallet);
  const value = token('race'); await register(value, 'granted', one.cookie);
  const list = devices.listGrantedDevices.bind(devices); let changed = false;
  t.mock.method(devices, 'listGrantedDevices', async (...args) => {
    const selected = await list(...args);
    if (!changed) { changed = true; await register(value, 'denied', one.cookie); }
    return selected;
  });
  const skipped = await call('admin/notifications', 'POST', { audience: 'player', playerId: one.playerId, ...notice }, admin.cookie);
  assert.equal(skipped.status, 409); assert.equal((await skipped.json()).skipped, 1); assert.equal(sends.length, 0);
  await register(value, 'granted', one.cookie);
  sendResponse = async () => {
    await register(value, 'granted', two.cookie);
    return Response.json({ error: { details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } }, { status: 404 });
  };
  const failed = await call('admin/notifications', 'POST', { audience: 'player', playerId: one.playerId, ...notice }, admin.cookie);
  assert.equal(failed.status, 502); assert.equal((await failed.json()).removed, 0);
  assert.equal((await devices.getGrantedDevice(value)).playerId, two.playerId);
});
