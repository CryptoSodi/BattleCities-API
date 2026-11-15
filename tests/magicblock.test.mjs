import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import crypto from 'node:crypto';
const require=createRequire(import.meta.url);
const policy=require('../src/services/magicBlockPolicy');
const service=require('../src/services/magicBlockDrops');
const {PublicKey}=require('@solana/web3.js');
const env={BATTLECITY_ENVIRONMENT:'devnet',BATTLECITY_SOLANA_NETWORK:'devnet',BATTLECITY_MAGICBLOCK_ENABLED:'1'};
const request=origin=>new Request('https://test.battlecities.com/api/magicblock/drop',{headers:origin?{origin}:{}});
test('only the exact Magic HTTPS origin on enabled devnet can use VRF',()=>{
  assert.equal(policy.allowed(request(policy.ORIGIN),env),true);
  for(const origin of [null,'https://test.battlecities.com','https://play.battlecities.com','http://magic.battlecities.com','https://magic.battlecities.com.evil.test','https://evil.test/?magic.battlecities.com','https://magic.battlecities.com:8443'])assert.equal(policy.allowed(request(origin),env),false,origin);
  for(const changes of [{BATTLECITY_MAGICBLOCK_ENABLED:'0'},{BATTLECITY_SOLANA_NETWORK:'mainnet-beta'},{BATTLECITY_ENVIRONMENT:'production'}])assert.equal(policy.allowed(request(policy.ORIGIN),{...env,...changes}),false);
});
test('session tokens bind identity, mode, expiry and map configuration',()=>{
  const secret='test-only-secret'.repeat(4),payload={playerId:'ply-a',mode:'magicblock',width:832,height:832,expires:Date.now()+10000};
  const token=policy.sign(payload,secret);assert.deepEqual(policy.verify(token,secret,'ply-a'),payload);
  assert.throws(()=>policy.verify(token,secret,'ply-b'));
  assert.throws(()=>policy.verify(policy.sign({...payload,expires:0},secret),secret,'ply-a'));
  assert.throws(()=>policy.verify(policy.sign({...payload,mode:'standard'},secret),secret,'ply-a'));
  assert.throws(()=>policy.verify(token.replace(token.split('.')[0],Buffer.from(JSON.stringify({...payload,width:4096})).toString('base64url')),secret,'ply-a'));
});
test('verified account decoding checks owner, match, index, dimensions and mapping',()=>{
  const game=new PublicKey(Buffer.alloc(32,3)),address=new PublicKey(Buffer.alloc(32,4));
  const session={width:832,height:832};const data=Buffer.alloc(84);
  crypto.createHash('sha256').update('account:Drop').digest().subarray(0,8).copy(data);game.toBuffer().copy(data,8);
  data.writeUInt16LE(832,42);data.writeUInt16LE(832,44);
  const info={owner:service.PROGRAM,data};
  assert.equal(service.decode(info,address,game,0,session).status,'pending');
  data[46]=1;data.writeUInt16LE(32,48);data.writeUInt16LE(32,50);
  assert.equal(service.decode(info,address,game,0,session).value,`defence|32|32|${address}`);
  assert.throws(()=>service.decode({...info,owner:game},address,game,0,session));
  assert.throws(()=>service.decode(info,address,address,0,session));
  assert.throws(()=>service.decode(info,address,game,1,session));
  data.writeUInt16LE(64,48);assert.throws(()=>service.decode(info,address,game,0,session));
});
