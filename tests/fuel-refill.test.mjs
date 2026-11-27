import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const economy = require('../dist/src/stores/economyStore');
const ledger = require('../dist/src/stores/ledgerStore');

test('initial fuel, exact refill boundary, cap, offline intervals and concurrent spending', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'battlecities-refill-'));
  process.env.NODE_ENV = 'test'; process.env.BATTLECITY_STORAGE_MODE = 'local';
  process.env.BATTLECITY_ECONOMY_DIR = path.join(root, 'economy');
  process.env.BATTLECITY_LEDGER_DIR = path.join(root, 'ledger');
  const player = { id: `ply-${crypto.randomUUID()}`, provider: 'wallet', walletAddress: 'test-wallet' };
  const realNow = Date.now;
  try {
    const initial = await economy.ensureAccountForPlayer(player);
    const start = Date.parse(initial.fuelRefillAt);
    let now = start;
    Date.now = () => now;
    assert.equal(initial.fuelBalance, 5);
    assert.equal(initial.tokenBalance, 0);
    assert.equal(initial.solBalance, 0);
    await economy.consumeFuelForPlayer(player, crypto.randomUUID(), 2);
    assert.equal((await economy.ensureAccountForPlayer(player)).fuelBalance, 2);
    now = start + 6 * 60 * 1000 - 1;
    assert.equal((await economy.ensureAccountForPlayer(player)).fuelBalance, 2);
    now++;
    const reads = await Promise.all(Array.from({ length: 12 }, () => economy.ensureAccountForPlayer(player)));
    assert.ok(reads.every(a => a.fuelBalance === 3));
    let refills = (await ledger.listEntriesForPlayer(player.id)).filter(e => e.sourceType === 'fuel-refill');
    assert.equal(refills.length, 1); assert.equal(refills[0].amount, 1);
    const display = economy.toPublicAccount(reads[0]).fuelRefill;
    assert.equal(display.cap, 5); assert.equal(display.intervalSeconds, 360);
    assert.equal(Date.parse(display.nextAt), start + 12 * 60 * 1000);
    now = start + 18 * 60 * 1000;
    assert.equal((await economy.ensureAccountForPlayer(player)).fuelBalance, 5);
    // A full interval is consumed, not banked for a later spend.
    now += 6 * 60 * 1000;
    await economy.ensureAccountForPlayer(player);
    await economy.consumeFuelForPlayer(player, crypto.randomUUID(), 0);
    assert.equal((await economy.ensureAccountForPlayer(player)).fuelBalance, 4);
    // Many missed intervals produce one top-up, never 5 per interval.
    now += 24 * 60 * 60 * 1000;
    assert.equal((await economy.ensureAccountForPlayer(player)).fuelBalance, 5);
    await economy.creditFuel(player, 20);
    now += 30 * 60 * 1000;
    assert.equal((await economy.ensureAccountForPlayer(player)).fuelBalance, 25);
    await economy.upsertAccountForPlayer(player, { fuelBalance: 0, fuelRefillAt: initial.fuelRefillAt });
    assert.equal((await economy.ensureAccountForPlayer(player)).fuelBalance, 0);
    now += 30 * 60 * 1000;
    const spends = await Promise.all(Array.from({ length: 10 }, () => economy.consumeFuelForPlayer(player, crypto.randomUUID(), 0)));
    assert.equal(spends.filter(r => r.ok).length, 5);
    assert.equal((await economy.ensureAccountForPlayer(player)).fuelBalance, 0);
    refills = (await ledger.listEntriesForPlayer(player.id)).filter(e => e.sourceType === 'fuel-refill');
    assert.deepEqual(refills.map(e => e.amount).sort((a,b) => a-b), [1, 1, 2, 5]);
    // Legacy local files have no checkpoint; creation time is the fallback.
    const legacy = { ...initial, playerId: `ply-${crypto.randomUUID()}`, fuelBalance: 0 };
    delete legacy.fuelRefillAt;
    await fs.writeFile(path.join(process.env.BATTLECITY_ECONOMY_DIR, `${legacy.playerId}.json`), JSON.stringify(legacy));
    assert.equal((await economy.ensureAccountForPlayer({ ...player, id: legacy.playerId })).fuelBalance, 5);
    const afterRefills = await economy.ensureAccountForPlayer(player);
    assert.equal(afterRefills.tokenBalance, 0);
    assert.equal(afterRefills.solBalance, 0);
    // Re-reading an existing account preserves its stored currency balances.
    const funded = { ...initial, playerId: `ply-${crypto.randomUUID()}`, tokenBalance: 23, solBalance: 0.5 };
    await fs.writeFile(path.join(process.env.BATTLECITY_ECONOMY_DIR, `${funded.playerId}.json`), JSON.stringify(funded));
    const preserved = await economy.ensureAccountForPlayer({ ...player, id: funded.playerId });
    assert.equal(preserved.tokenBalance, 23);
    assert.equal(preserved.solBalance, 0.5);
  } finally {
    Date.now = realNow;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a newly applied referral does not backdate the faster rate', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'battlecities-refill-referral-'));
  process.env.NODE_ENV='test';process.env.BATTLECITY_STORAGE_MODE='local';
  process.env.BATTLECITY_ECONOMY_DIR=path.join(root,'economy');
  process.env.BATTLECITY_LEDGER_DIR=path.join(root,'ledger');
  process.env.BATTLECITY_REFERRALS_FILE=path.join(root,'referrals.json');
  const player={id:`ply-${crypto.randomUUID()}`,provider:'wallet',walletAddress:'test-wallet'};
  const realNow=Date.now;
  try {
    const initial=await economy.ensureAccountForPlayer(player);
    const start=Date.parse(initial.fuelRefillAt);
    Date.now=()=>start;
    await economy.upsertAccountForPlayer(player,{fuelBalance:0});
    const applied=start+31*60*1000;
    await fs.writeFile(process.env.BATTLECITY_REFERRALS_FILE,JSON.stringify({profiles:{},rewards:{},referrals:{[player.id]:{referrer:'ply-other',createdAt:new Date(applied).toISOString()}}}));
    Date.now=()=>applied;
    assert.equal((await economy.ensureAccountForPlayer(player)).fuelBalance,5);
    Date.now=()=>start+35*60*1000-1;
    assert.equal((await economy.ensureAccountForPlayer(player)).fuelBalance,5);
    Date.now=()=>start+35*60*1000;
    assert.equal((await economy.ensureAccountForPlayer(player)).fuelBalance,6);
  } finally {Date.now=realNow;delete process.env.BATTLECITY_REFERRALS_FILE;await fs.rm(root,{recursive:true,force:true});}
});

test('account endpoint returns server-authoritative refill timing', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'battlecities-refill-route-'));
  process.env.NODE_ENV='test';process.env.BATTLECITY_STORAGE_MODE='local';
  process.env.BATTLECITY_ECONOMY_DIR=path.join(root,'economy');
  process.env.BATTLECITY_LEDGER_DIR=path.join(root,'ledger');
  const player={id:`ply-${crypto.randomUUID()}`,provider:'wallet',walletAddress:'test-wallet'};
  const identity=require('../dist/src/services/sessionIdentity');
  const sessions=require('../dist/src/stores/sessionStore');
  const players=require('../dist/src/stores/playerStore');
  const route=require('../dist/src/routes/economy/account');
  try {
    t.mock.method(identity,'resolveSession',()=> 'session-test');
    t.mock.method(sessions,'readSession',async()=>({playerId:player.id}));
    t.mock.method(players,'readPlayerForSession',async()=>player);
    t.mock.method(players,'toPublicPlayer',()=>({id:player.id}));
    const response=await route.GET(new Request('https://api.battlecities.com/api/economy/account'));
    const data=await response.json();
    assert.equal(response.status,200);assert.equal(data.account.playerId,player.id);
    assert.equal(data.account.fuelRefill.cap,5);
    assert.equal(data.account.fuelRefill.intervalSeconds,360);
    assert.ok(Date.parse(data.account.fuelRefill.nextAt)>Date.parse(data.account.fuelRefill.serverTime));
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
