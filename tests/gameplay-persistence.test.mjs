import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test, { beforeEach, afterEach } from 'node:test';
const require = createRequire(import.meta.url);
const api = require('../dist/src/api/router').default;
const economy = require('../dist/src/stores/economyStore');
const ledger = require('../dist/src/stores/ledgerStore');
const players = require('../dist/src/stores/playerStore');
const matches = require('../dist/src/stores/matchResultStore');
const sessions = require('../dist/src/stores/sessionStore');
const seasons = require('../dist/src/stores/seasonStore');
const competitions = require('../dist/src/services/competitions');
const competitionStore = require('../dist/src/stores/competitionStore');
let root;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'battlecities-gameplay-'));
  process.env.NODE_ENV = 'test'; process.env.BATTLECITY_STORAGE_MODE = 'local';
  for (const name of ['PLAYER', 'SESSION', 'ECONOMY', 'LEDGER', 'MATCH', 'SEASON']) process.env[`BATTLECITY_${name}_DIR`] = path.join(root, name);
  process.env.BATTLECITY_COMPETITIONS_FILE = path.join(root, 'competitions.json');
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
function call(route, method = 'GET', body, cookie = '') {
  return api.fetch(new Request(`https://api.battlecities.com/api/${route}`, {
    method, headers: { 'content-type': 'application/json', cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}
async function guest() {
  const session = await sessions.createGuestSession();
  return { player: await players.readPlayer(session.playerId), cookie: `battlecity_session=${session.id}` };
}

test('fuel endpoint authenticates, validates tiers, returns saved balance and charges retries once', async () => {
  const requestId = crypto.randomUUID();
  assert.equal((await call('economy/fuel/consume', 'POST', { requestId, tankTier: 0 })).status, 401);
  const { player, cookie } = await guest();
  for (const invalid of [{ requestId: 'bad', tankTier: 0 }, { requestId, tankTier: -1 }, { requestId, tankTier: 4 }, { requestId, tankTier: '1' }]) {
    assert.equal((await call('economy/fuel/consume', 'POST', { ...invalid, expectedPlayerId: player.id }, cookie)).status, 400);
  }
  const first = await call('economy/fuel/consume', 'POST', { requestId, tankTier: 2, expectedPlayerId: player.id }, cookie);
  assert.equal(first.status, 200);
  const result = await first.json();
  assert.equal(result.ok, true); assert.equal(result.requestId, requestId);
  assert.equal(result.fuelConsumed, 3); assert.equal(result.account.fuelBalance, 2);
  const retry = await (await call('economy/fuel/consume', 'POST', { requestId: requestId.toUpperCase(), tankTier: 2, expectedPlayerId: player.id }, cookie)).json();
  assert.equal(retry.idempotent, true); assert.equal(retry.fuelConsumed, 3); assert.equal(retry.account.fuelBalance, 2);
  const mismatch = await call('economy/fuel/consume', 'POST', { requestId, tankTier: 0, expectedPlayerId: player.id }, cookie);
  assert.equal(mismatch.status, 409); assert.equal((await mismatch.json()).fuelConsumed, 0);
  const insufficient = await call('economy/fuel/consume', 'POST', { requestId: crypto.randomUUID(), tankTier: 3, expectedPlayerId: player.id }, cookie);
  assert.equal(insufficient.status, 409); assert.equal((await insufficient.json()).account.fuelBalance, 2);
  const entries = await ledger.listEntriesForPlayer(player.id);
  assert.equal(entries.length, 1); assert.equal(entries[0].amount, -3); assert.equal(entries[0].sourceId, requestId);
});

test('concurrent duplicate and distinct start requests cannot double charge or overdraw', async () => {
  const { player, cookie } = await guest();
  const requestId = crypto.randomUUID();
  const duplicate = await Promise.all(Array.from({ length: 10 }, () => call('economy/fuel/consume', 'POST', { requestId, tankTier: 0, expectedPlayerId: player.id }, cookie).then(r => r.json())));
  assert.equal(duplicate.filter(r => !r.idempotent).length, 1);
  assert.ok(duplicate.every(r => r.ok && r.account.fuelBalance === 4));
  const distinct = await Promise.all(Array.from({ length: 10 }, () => call('economy/fuel/consume', 'POST', { requestId: crypto.randomUUID(), tankTier: 0, expectedPlayerId: player.id }, cookie)));
  assert.equal(distinct.filter(r => r.status === 200).length, 4);
  assert.equal(distinct.filter(r => r.status === 409).length, 6);
  assert.equal((await economy.readAccount(player.id)).fuelBalance, 0);
  assert.equal((await ledger.listEntriesForPlayer(player.id)).length, 5);
});

test('fuel and opted-in account saves reject a switched session before touching the other account', async () => {
  const first = await guest(), second = await guest();
  const requestId = crypto.randomUUID();
  for (const expectedPlayerId of [undefined, null, 42, 'wallet-address']) {
    const invalid = await call('economy/fuel/consume', 'POST', { requestId, tankTier: 0, expectedPlayerId }, second.cookie);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).account, undefined);
  }
  const switched = await call('economy/fuel/consume', 'POST', { requestId, tankTier: 0, expectedPlayerId: first.player.id }, second.cookie);
  assert.equal(switched.status, 409);
  assert.deepEqual(await switched.json(), { ok: false, requestId, fuelConsumed: 0, error: 'Player session changed' });
  assert.equal(await economy.readAccount(second.player.id), null);
  assert.deepEqual(await ledger.listEntriesForPlayer(second.player.id), []);
  const save = await call('economy/account', 'PUT', { expectedPlayerId: first.player.id, account: { fuelBalance: 0, loadout: {} } }, second.cookie);
  assert.equal(save.status, 409); assert.equal((await save.json()).error, 'Player session changed');
  assert.equal(await economy.readAccount(second.player.id), null);
  const invalidSave = await call('economy/account', 'PUT', { expectedPlayerId: null, account: { loadout: {} } }, second.cookie);
  assert.equal(invalidSave.status, 400);
  assert.equal(await economy.readAccount(second.player.id), null);
  const valid = await call('economy/fuel/consume', 'POST', { requestId, tankTier: 0, expectedPlayerId: second.player.id }, second.cookie);
  assert.equal(valid.status, 200); assert.equal((await valid.json()).account.fuelBalance, 4);
  const ownSave = await call('economy/account', 'PUT', { expectedPlayerId: second.player.id, account: { loadout: {} } }, second.cookie);
  assert.equal(ownSave.status, 200); assert.equal((await ownSave.json()).account.fuelBalance, 4);
});

test('account GET cannot overwrite a concurrent debit and partial PUT preserves loadout', async (t) => {
  const { player, cookie } = await guest();
  const account = await economy.ensureAccountForPlayer(player);
  account.inventory.shield = 2; account.loadout['active-one'] = 'shield';
  const accountPath = path.join(root, 'ECONOMY', `${player.id}.json`);
  await fs.writeFile(accountPath, JSON.stringify(account));
  const originalRead = fs.readFile;
  let reached;
  const reading = new Promise(resolve => { reached = resolve; });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let hold = true;
  t.mock.method(fs, 'readFile', async (...args) => {
    const value = await originalRead(...args);
    if (hold && args[0] === accountPath) { hold = false; reached(); await blocked; }
    return value;
  });
  const pendingGet = call('economy/account', 'GET', undefined, cookie);
  await reading;
  // Reads now share the account lock because they may apply an elapsed refill.
  const pendingDebit = economy.consumeFuelForPlayer(player, crypto.randomUUID(), 1);
  release();
  const [get, debit] = await Promise.all([pendingGet, pendingDebit]);
  assert.equal(get.status, 200);
  assert.equal(debit.account.fuelBalance, 3);
  assert.equal((await economy.readAccount(player.id)).fuelBalance, 3);
  const update = await call('economy/account', 'PUT', { fuelBalance: 2 }, cookie);
  assert.equal(update.status, 200);
  const saved = (await update.json()).account;
  assert.equal(saved.fuelBalance, 2); assert.equal(saved.loadout['active-one'], 'shield'); assert.equal(saved.inventory.shield, 2);
});

test('saved matches monotonically persist personal highscores and pending wallet cycle scores without prize approval', async () => {
  const wallet = require('@solana/web3.js').Keypair.generate().publicKey.toBase58();
  const player = await players.findOrCreateWalletPlayer(wallet);
  await players.mergeHighscores(player.id, 100, 350);
  const season = await seasons.getCurrentSeason();
  const scores = [1000, 2500, 400, 1700, 800];
  const results = await Promise.all(scores.map(async score => {
    const [result] = await Promise.all([
      matches.submitResult(player, season, { mode: 'single', score, levelNumber: 1, won: false }),
      players.findOrCreateWalletPlayer(wallet),
    ]);
    return result;
  }));
  assert.ok(results.every(r => r.validationStatus === 'pending' && r.prizeReview === undefined));
  const saved = await players.readPlayer(player.id);
  assert.equal(saved.highscorePrimary, 2500); assert.equal(saved.highscoreSecondary, 350);
  const cycle = competitions.cycleAt();
  const board = await competitions.board(cycle);
  assert.equal(board.find(row => row.playerId === player.id).matches, scores.length);
  assert.deepEqual(await competitions.board(cycle, true), []);
  assert.deepEqual(await matches.getLeaderboard(season.id), []);
  await competitionStore.grantPass(player.id, season, 'test-pass-signature', new Date().toISOString());
  assert.equal((await matches.getLeaderboard(season.id))[0].matches, scores.length);
});
