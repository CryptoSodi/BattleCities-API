import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
const { validateReplay } = createRequire(import.meta.url)('../src/services/unityReplayFormat.js');
function replay(mode='single') {
  return {format:'battlecities-unity-input-v1',simulationVersion:'unity-sim-v1',buildVersion:'1.0.5',mode,
    id:'0123456789abcdef0123456789abcdef',createdAt:'2026-10-19T12:00:00Z',seed:1,levelNumber:1,tickRate:60,durationTicks:120,
    levelHash:'a'.repeat(64),configHash:'b'.repeat(64),completion:'completed',debugUsed:false,
    map:{field:{widthTiles:13,heightTiles:13},terrain:{regions:[]},objects:[],spawn:null,base:null},
    config:{normalReload:.12,upgradedReload:.08,playerTier:0,turretRange:640,turretDamage:4,turretHealth:10,
      turretCooldown:.1,turretReload:.5,turretTurn:.2,turretMuzzle:32,turretDeploy:.5,landDrone:{}},
    inputs:[{tick:1,count:120,commands:[0,0,0,0],secondaries:[0,0,0,0],enemyFire:true}],events:[],
    checkpoints:[0,60,120].map(tick=>({tick,stateHash:'c'.repeat(64)})),
    claimedResult:{score:1000,lives:0,remaining:10,won:false,lost:true,winnerSlot:-1}};
}
test('legacy and new tank profile recordings are accepted',()=>{
  const old=replay();assert.doesNotThrow(()=>validateReplay(old));
  const current=replay();current.config.tankStatsVersion=1;assert.doesNotThrow(()=>validateReplay(current));
  for(let tier=0;tier<4;tier++) {
    const coop=replay('coop');coop.config.tankStatsVersion=1;
    coop.events=[{tick:1,slot:0,connected:false,kind:'tank',value:String(tier)}];
    assert.doesNotThrow(()=>validateReplay(coop));
  }
});
test('unsupported profiles and invalid tank selections are rejected',()=>{
  for(const version of [-1,2,'1',null]) {const r=replay();r.config.tankStatsVersion=version;assert.throws(()=>validateReplay(r));}
  for(const value of ['4','-1','02',2,null]) {
    const r=replay('coop');r.config.tankStatsVersion=1;r.events=[{tick:1,slot:0,connected:false,kind:'tank',value}];assert.throws(()=>validateReplay(r));
  }
  for(const mode of ['single','coop']) {
    const r=replay(mode);if(mode==='single')r.config.tankStatsVersion=1;
    r.events=[{tick:1,slot:0,connected:false,kind:'tank',value:'2'}];assert.throws(()=>validateReplay(r));
  }
});

test('new power-up events and versioned drop pools validate without weakening unknown-type rejection',()=>{
  for(const type of ['healmax','heal2','rapid','rapidlong']){
    const r=replay();r.config.powerupRosterVersion=1;r.events=[{tick:1,slot:0,connected:false,kind:'powerup',value:type}];
    assert.doesNotThrow(()=>validateReplay(r));
  }
  for(const version of [-1,2,'1',null]){const r=replay();r.config.powerupRosterVersion=version;assert.throws(()=>validateReplay(r));}
  const forged=replay();forged.events=[{tick:1,slot:0,connected:false,kind:'powerup',value:'infinite-health'}];assert.throws(()=>validateReplay(forged));
});

test('Wipeout damage rule is versioned and older recordings remain valid',()=>{
  for(const version of [0,1]){const r=replay();r.config.wipeoutDamageVersion=version;r.events=[{tick:1,slot:0,connected:false,kind:'powerup',value:'wipeout'}];assert.doesNotThrow(()=>validateReplay(r));}
  for(const version of [-1,2,'1',null]){const r=replay();r.config.wipeoutDamageVersion=version;assert.throws(()=>validateReplay(r));}
});
