import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { Keypair } = require('@solana/web3.js');
const players = require('../dist/src/stores/playerStore');
const referrals = require('../dist/src/stores/referralStore');
const economy = require('../dist/src/stores/economyStore');
const routes = require('../dist/src/routes/referrals');
const identity = require('../dist/src/services/sessionIdentity');
const sessions = require('../dist/src/stores/sessionStore');

test('a referral is permanent, refills to six, and accrues each confirmed payment once', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'battlecities-referrals-'));
  process.env.NODE_ENV='test';process.env.BATTLECITY_STORAGE_MODE='local';
  process.env.BATTLECITY_PLAYER_DIR=path.join(root,'players');
  process.env.BATTLECITY_ECONOMY_DIR=path.join(root,'economy');
  process.env.BATTLECITY_LEDGER_DIR=path.join(root,'ledger');
  process.env.BATTLECITY_REFERRALS_FILE=path.join(root,'referrals.json');
  const realNow=Date.now;
  try {
    const first=await players.findOrCreateWalletPlayer(Keypair.generate().publicKey.toBase58());
    const one=await referrals.ensureProfile({...first,createdAt:'2000-01-01T00:00:00Z'});
    assert.equal(one.prompt,false);
    const second=await players.findOrCreateWalletPlayer(Keypair.generate().publicKey.toBase58());
    const three=await players.findOrCreateWalletPlayer(Keypair.generate().publicKey.toBase58());
    const thirdProfile=await referrals.ensureProfile(three);
    assert.equal((await referrals.ensureProfile(second)).prompt,true);
    assert.equal(thirdProfile.prompt,true);
    await referrals.dismissPrompt(three);
    assert.equal((await referrals.ensureProfile(three)).prompt,false);
    await referrals.applyCode(three,one.code);
    assert.equal((await referrals.ensureProfile(three)).referred,true);
    assert.equal(one.link,`https://battlecities.com/?ref=${one.code}`);
    assert.equal(referrals.codeFromInput(one.link),one.code);
    assert.throws(()=>referrals.codeFromInput(`https://battlecities.com.attacker.test/?ref=${one.code}`));
    await assert.rejects(referrals.applyCode(first,one.code),/own referral/);
    await assert.rejects(referrals.applyCode(second,'FFFFFFFFFFFF'),/not found/);
    const account=await economy.ensureAccountForPlayer(second);
    const starts=Date.parse(account.fuelRefillAt);
    await Promise.all(Array.from({length:5},()=>referrals.applyCode(second,one.link)));
    await assert.rejects(referrals.applyCode(second,thirdProfile.code),/already been applied/);
    assert.equal((await referrals.ensureProfile(second)).referred,true);
    Date.now=()=>starts+5*60*1000-1;
    assert.equal((await economy.ensureAccountForPlayer(second)).fuelBalance,5);
    Date.now=()=>starts+5*60*1000+100;
    assert.equal((await economy.ensureAccountForPlayer(second)).fuelBalance,6);
    await economy.upsertAccountForPlayer(second, { fuelBalance: 0 });
    Date.now=()=>starts+10*60*1000+100;
    const gradual=await economy.ensureAccountForPlayer(second);
    assert.equal(gradual.fuelBalance,1);
    assert.equal(economy.toPublicAccount(gradual).fuelRefill.intervalSeconds,300);
    Date.now=()=>starts+35*60*1000+100;
    assert.equal((await economy.ensureAccountForPlayer(second)).fuelBalance,6);
    await economy.creditFuel(second,10);
    Date.now=()=>starts+60*60*1000;
    assert.equal((await economy.ensureAccountForPlayer(second)).fuelBalance,16);
    const confirmedAt=new Date(realNow()+1000).toISOString();
    const payment={signature:'payment-1',playerId:second.id,currency:'sol',amountAtomic:'100000001',confirmedAt,network:'mainnet-beta',mint:null,tokenProgram:null,decimals:9};
    await Promise.all(Array.from({length:5},()=>referrals.accruePayment(payment)));
    await referrals.accruePayment({...payment,signature:'payment-2',currency:'skr',amountAtomic:'12345',mint:'skr-mint',tokenProgram:'token-program',decimals:6});
    await referrals.accruePayment({...payment,signature:'old-payment',confirmedAt:'2000-01-01T00:00:00Z'});
    assert.deepEqual((await referrals.ensureProfile(first)).rewards.map(r=>[r.currency,r.amountAtomic,r.amount]),[['sol','1000000','0.001'],['skr','123','0.000123']]);
    assert.deepEqual((await referrals.ensureProfile(three)).rewards,[]);
    await referrals.dismissPrompt(second);
    assert.equal((await referrals.ensureProfile(second)).prompt,false);
  } finally {Date.now=realNow;await fs.rm(root,{recursive:true,force:true});}
});

test('referral routes require a verified player and reject stale sessions', async (t) => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'battlecities-referral-api-'));
  process.env.NODE_ENV='test';process.env.BATTLECITY_STORAGE_MODE='local';
  process.env.BATTLECITY_PLAYER_DIR=path.join(root,'players');
  process.env.BATTLECITY_REFERRALS_FILE=path.join(root,'referrals.json');
  const request=(method,body)=>new Request('https://api.battlecities.com/api/referrals',{
    method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}) });
  try {
    assert.equal((await routes.GET(request('GET'))).status,401);
    assert.equal((await routes.POST(request('POST',{}))).status,401);
    const player=await players.findOrCreateWalletPlayer(Keypair.generate().publicKey.toBase58());
    t.mock.method(identity,'resolveSession',()=> 'session-test');
    t.mock.method(sessions,'readSession',async()=>({playerId:player.id}));
    t.mock.method(players,'readPlayerForSession',async()=>player);
    assert.equal((await routes.POST(request('POST',{action:'dismiss',expectedPlayerId:'ply-old'}))).status,409);
    const response=await routes.GET(request('GET'));
    assert.equal(response.status,200);
    const state=await response.json();
    assert.match(state.referral.code,/^[A-F0-9]{12}$/);
    assert.equal((await routes.POST(request('POST',{action:'dismiss',expectedPlayerId:player.id}))).status,200);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
