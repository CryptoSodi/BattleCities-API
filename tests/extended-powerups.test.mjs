import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test, { beforeEach, afterEach } from 'node:test';
const require=createRequire(import.meta.url);
const economy=require('../dist/src/stores/economyStore');
const catalog=require('../dist/src/routes/economy/catalog');
const sessions=require('../dist/src/stores/sessionStore');
const players=require('../dist/src/stores/playerStore');
const app=require('../dist/src/app').default;
const drops=require('../dist/src/services/batcPowerupDrops');
const cases=[['max-healer','healmax',450,.02],['health-healer','heal2',450,.01],['rapid-shooter','rapid',450,.01],['rapid-shooter-long','rapidlong',900,.02]];
let root;
beforeEach(async()=>{
 root=await fs.mkdtemp(path.join(os.tmpdir(),'battlecities-new-powers-'));
 process.env.NODE_ENV='test';process.env.BATTLECITY_STORAGE_MODE='local';
 for(const key of ['ECONOMY','LEDGER','SEASON','PLAYER','SESSION'])process.env[`BATTLECITY_${key}_DIR`]=path.join(root,key);
 process.env.BATTLECITY_COMPETITIONS_FILE=path.join(root,'competitions.json');
});
afterEach(async()=>{await fs.rm(root,{recursive:true,force:true});});
test('catalog exposes approved SOL/SKR prices and correct single-item rewards',async()=>{
 const r=await catalog.GET(new Request('https://api.battlecities.com/api/economy/catalog'));assert.equal(r.status,200);
 const body=await r.json();
 for(const [id,,skr,sol] of cases){
  const item=body.items.find(v=>v.id===id);assert.ok(item,id);assert.equal(Number(item.solPrice),sol);assert.equal(Number(item.skrPrice),skr);assert.deepEqual(item.inventory,{[id]:1});
 }
});
test('new items grant inventory, survive loadout saves, and authenticated consumption is idempotent',async()=>{
 const session=await sessions.createGuestSession();const player=await players.readPlayer(session.playerId);const cookie=`battlecity_session=${session.id}`;
 for(const [id,type,skr,sol] of cases){
  const granted=await economy.grantOnChainPurchaseForPlayer(player,id,'sol',`test-${id}`,null);
  assert.equal(granted.inventory[id],1);assert.equal(economy.getShopCatalogItem(id).price,skr);assert.equal(economy.getShopCatalogItem(id).solPrice,sol);
  const saved=await economy.upsertAccountForPlayer(player,{loadout:{'active-one':id}});assert.equal(saved.loadout['active-one'],id);
  const requestId=crypto.randomUUID();
  const call=(powerupType=type)=>app.fetch(new Request('https://api.battlecities.com/api/economy/powerups/consume',{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({itemId:id,powerupType,requestId})}));
  const invalid=await call('shield');assert.equal(invalid.status,400);assert.equal((await economy.readAccount(player.id)).inventory[id],1);
  const first=await call();assert.equal(first.status,200);assert.equal((await first.json()).powerupType,type);
  const retry=await call();assert.equal(retry.status,200);assert.equal((await retry.json()).idempotent,true);
  assert.equal((await economy.readAccount(player.id)).inventory[id],0);
 }
});

test('new clients can roll each addition while old clients retain their eight-type pool',async(t)=>{
 let desired=8;const limits=[];
 t.mock.method(crypto,'randomInt',limit=>{limits.push(limit);return Math.min(desired,limit-1);});
 for(const [offset,type] of ['healmax','heal2','rapid','rapidlong'].entries()){
  desired=8+offset;assert.equal((await drops.roll(null,'drop-test',1,1)).dropType,type);
  assert.equal((await drops.roll(null,'drop-test',1)).dropType,'wipeout');
 }
 assert.deepEqual(limits,[12,8,12,8,12,8,12,8]);
 const invalid=await app.fetch(new Request('https://api.battlecities.com/api/economy/drops/roll',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({powerupRosterVersion:2})}));
 assert.equal(invalid.status,400);
});
