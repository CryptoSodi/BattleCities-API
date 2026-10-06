import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test, { beforeEach, afterEach } from 'node:test';
const require = createRequire(import.meta.url);
const base = '../dist/api-server/src/';
const admin = require(base + 'routes/admin/competitions');
const reviews = require(base + 'routes/admin/matchReviews');
const catalog = require(base + 'routes/economy/catalog');
const history = require(base + 'routes/leaderboardHistory');
const native = require(base + 'routes/integrations/nativeOAuth');
const swap = require(base + 'routes/trading/swap');
const sessions = require(base + 'stores/sessionStore');
const players = require(base + 'stores/playerStore');
const identity = require(base + 'services/sessionIdentity');
const config = require(base + 'services/competitionConfig');
const store = require(base + 'stores/competitionStore');
const { Keypair } = require('@solana/web3.js');
let root;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'battlecities-routes-'));
  process.env.NODE_ENV = 'test'; process.env.BATTLECITY_STORAGE_MODE = 'local';
  process.env.BATTLECITY_COMPETITIONS_FILE = path.join(root, 'competitions.json');
  process.env.BATTLECITY_SEASON_DIR = path.join(root, 'seasons');
  process.env.BATTLECITY_SKR_MINT = Keypair.generate().publicKey.toBase58();
  process.env.BATTLECITY_SKR_DECIMALS = '6';
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const req = (pathname, method = 'GET', body) => new Request('https://api.battlecities.com/api/' + pathname,
  { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });

test('new private endpoints reject unauthenticated access', async () => {
  for (const [handler, pathname, method] of [[admin.GET, 'admin/competitions', 'GET'],
    [admin.PUT, 'admin/competitions', 'PUT'], [reviews.POST, 'admin/match-reviews', 'POST'],
    [native.POST, 'integrations/x/oauth/native/start', 'POST'], [native.GET, 'integrations/oauth/native/status', 'GET'],
    [swap.POST, 'trading/swap/quote', 'POST']]) {
    assert.equal((await handler(req(pathname, method))).status, 401);
  }
});

test('admin prices are access controlled and immediately reflected in the shop catalog', async (t) => {
  t.mock.method(identity, 'resolveSession', () => 'session-test');
  let email = 'ordinary@example.com';
  t.mock.method(sessions, 'readSession', async () => ({ playerId: 'ply-test', provider: 'google', googleEmail: email }));
  t.mock.method(players, 'readPlayer', async () => ({ id: 'ply-test', provider: 'google', displayName: 'Test Player' }));
  assert.equal((await admin.GET(req('admin/competitions'))).status, 403);
  email = 'tassaduq009@gmail.com';
  const value = { ...config.defaults(), seasonPass: { enabled: true, solPrice: '0.05', skrPrice: '200' } };
  assert.equal((await admin.PUT(req('admin/competitions', 'PUT', value))).status, 200);
  const response = await catalog.GET(req('economy/catalog'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.seasonPass.scoringPolicy, 'all_matches_in_season');
  assert.equal(body.seasonPass.prices.skr, '200');
  assert.equal(body.seasonPass.owned, false);
  assert.ok(body.items.length > 0);
  assert.equal((await admin.PUT(req('admin/competitions', 'PUT', { ...value, seasonPass: { enabled: true, skrPrice: '-5', solPrice: '0.05' } }))).status, 400);
});

test('public history pagination validates limits and never exposes signed payout bytes', async () => {
  assert.equal((await history.GET(req('leaderboard/cycles?limit=0'))).status, 400);
  assert.equal((await history.GET(req('leaderboard/cycles?before=invalid'))).status, 400);
  assert.equal((await history.GET(req('leaderboard/cycles?id=garbage'))).status, 400);
  assert.deepEqual((await (await history.GET(req('leaderboard/payouts'))).json()).items, []);
  const p = await store.ensurePeriod({ id: 'cycle:1791194400000', kind: 'cycle', scope: 'gaming',
    startsAt: '2026-10-05T10:00:00Z', endsAt: '2026-10-05T10:30:00Z', policy: { enabled: false, prizes: [] } });
  await store.closePeriod(p.id, [], [{ id: 'payout-one', periodId: p.id, playerId: 'ply-test', rank: 1,
    amount: '10', tokenConfig: {}, walletAddress: 'test-wallet', status: 'pending' }]);
  await store.preparePayout('payout-one', null, { signature: 'public-signature', rawTransaction: 'secret-signed-bytes' });
  const response = await history.GET(req('leaderboard/payouts?playerId=ply-test&limit=1'));
  const body = await response.json();
  assert.equal(body.items[0].signature, 'public-signature');
  assert.equal(body.nextBefore, 'payout-one');
  assert.equal(JSON.stringify(body).includes('secret-signed-bytes'), false);
});
