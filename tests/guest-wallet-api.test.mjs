import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import test, { beforeEach, afterEach } from 'node:test';
const require = createRequire(import.meta.url);
const app = require('../dist/api-server/src/app').default;
const bs58 = require('bs58').default;
let root;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'battlecities-identity-'));
  process.env.NODE_ENV = 'test'; process.env.BATTLECITY_STORAGE_MODE = 'local';
  process.env.BATTLECITY_DROP_REWARDS_ENABLED = '0';
  for (const dir of ['PLAYER', 'SESSION', 'ECONOMY', 'LEDGER', 'MATCH', 'WALLET_CHALLENGE', 'SEASON']) {
    process.env[`BATTLECITY_${dir}_DIR`] = path.join(root, dir);
  }
  process.env.BATTLECITY_COMPETITIONS_FILE = path.join(root, 'competitions.json');
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
function request(route, method = 'GET', body, cookie = '') {
  return new Request(`https://api.battlecities.com/api/${route}`, { method,
    headers: { 'content-type': 'application/json', cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const call = (...args) => app.fetch(request(...args));

test('guest identity resumes by cookie and keeps progress without prize or admin access', async () => {
  const response = await call('session', 'POST', { provider: 'guest', playerId: 'ply-victim' });
  assert.equal(response.status, 201);
  const guest = await response.json();
  assert.equal(guest.provider, 'guest'); assert.notEqual(guest.playerId, 'ply-victim');
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await (await call('session', 'POST', { provider: 'guest' }, cookie)).json()).playerId, guest.playerId);
  const account = await (await call('economy/account', 'GET', undefined, cookie)).json();
  assert.equal(account.account.fuelBalance, 5);
  const file = path.join(root, 'ECONOMY', `${guest.playerId}.json`);
  const saved = JSON.parse(await fs.readFile(file, 'utf8')); saved.inventory.shield = 1;
  await fs.writeFile(file, JSON.stringify(saved));
  const consume = { itemId: 'shield', powerupType: 'shield', requestId: 'powerup:guest-test-1' };
  assert.equal((await call('economy/powerups/consume', 'POST', consume, cookie)).status, 200);
  assert.equal((await (await call('economy/powerups/consume', 'POST', consume, cookie)).json()).idempotent, true);
  const match = await (await call('matches/submit', 'POST', { mode: 'single', score: 5000, levelNumber: 1, gamePoints: 999999, validationStatus: 'accepted' }, cookie)).json();
  assert.equal(match.result.gamePoints, 500); assert.equal(match.result.validationStatus, 'pending');
  assert.equal((await call('matches/submit', 'POST', { mode: 'multi' }, cookie)).status, 400);
  const player = await (await call('player', 'GET', undefined, cookie)).json();
  assert.equal(player.player.progression.points, 500);
  const profile = await (await call(`players/${guest.playerId}/profile`)).json();
  assert.equal(profile.item.stats.allTime.totalPoints, 500); assert.equal(profile.item.stats.allTime.rank, null);
  assert.deepEqual((await (await call('leaderboard/rewards', 'GET', undefined, cookie)).json()).rows, []);
  for (const endpoint of ['admin/session', 'economy/purchase/quote', 'trading/swap/quote', 'integrations/x/oauth/native/start']) {
    assert.equal((await call(endpoint, endpoint === 'admin/session' ? 'GET' : 'POST', endpoint === 'admin/session' ? undefined : {}, cookie)).status, 403, endpoint);
  }
  assert.equal((await call('economy/drops/roll', 'POST', { requestId: 'guest-drop', levelNumber: 1 }, cookie)).status, 200);
  await call('session', 'DELETE', undefined, cookie);
  assert.equal((await (await call('session', 'GET', undefined, cookie)).json()).authenticated, false);
});

test('wallet challenge signs the exact message and allows one concurrent use', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const address = bs58.encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  const challenge = await (await call('session', 'PUT', { walletAddress: address })).json();
  const signature = crypto.sign(null, Buffer.from(challenge.message), privateKey).toString('base64');
  assert.equal((await call('session', 'POST', { provider: 'wallet', walletAddress: address, ...challenge, signature: 'invalid' })).status, 401);
  const payload = { provider: 'wallet', walletAddress: address, ...challenge, signature };
  const responses = await Promise.all([call('session', 'POST', payload), call('session', 'POST', payload)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 401]);
  const loggedIn = responses.find((r) => r.status === 201);
  const session = await loggedIn.json(); const cookie = loggedIn.headers.get('set-cookie').split(';')[0];
  assert.equal(session.walletAddress, address); assert.equal(session.provider, 'wallet');
  assert.equal((await call('admin/session', 'GET', undefined, cookie)).status, 403);
  assert.equal((await call('session', 'POST', payload)).status, 401);
});

test('legacy Google sessions and identities cannot authenticate, authorize or expose profiles', async () => {
  await fs.mkdir(path.join(root, 'SESSION')); await fs.mkdir(path.join(root, 'PLAYER'));
  const now = new Date().toISOString();
  const player = { id: 'ply-old-google', provider: 'google', displayName: 'Old identity', createdAt: now, updatedAt: now, lastSeenAt: now };
  await fs.writeFile(path.join(root, 'PLAYER', `${player.id}.json`), JSON.stringify(player));
  await fs.writeFile(path.join(root, 'SESSION', 'sess-old-google.json'), JSON.stringify({ id: 'sess-old-google', provider: 'google', playerId: player.id, createdAt: now, lastSeenAt: now }));
  const cookie = 'battlecity_session=sess-old-google';
  assert.equal((await (await call('session', 'GET', undefined, cookie)).json()).authenticated, false);
  assert.equal((await call('admin/session', 'GET', undefined, cookie)).status, 401);
  assert.equal((await call(`players/${player.id}/profile`)).status, 404);
  assert.equal((await call('session', 'POST', { provider: 'google', idToken: 'anything' })).status, 400);
});

test('all retired static and dynamic routes return 404', async () => {
  const routes = ['auth/google/start', 'auth/google/native', 'auth/google/callback', 'multiplayer/direct/start', 'multiplayer/matches/live',
    'multiplayer/matches/test/spectate', 'multiplayer/archives/test', 'webrtc/matches/test/observers', 'webrtc/matches/test/players/0/signals/offer',
    'admin/tournaments', 'admin/tournaments/test/prizes/distribute', 'events', 'events/test/enter', 'phases', 'quests/claim', 'staking/summary',
    'presale/state', 'airdrops/claim', 'boost/status', 'cherry-embed-token'];
  for (const route of routes) for (const method of ['GET', 'POST', 'OPTIONS']) {
    assert.equal((await call(route, method, method === 'POST' ? {} : undefined)).status, 404, `${method} ${route}`);
  }
});
