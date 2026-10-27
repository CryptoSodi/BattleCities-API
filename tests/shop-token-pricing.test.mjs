import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';
const require=createRequire(import.meta.url);
const pricing=require('../src/services/shopTokenPricing');
const play=require('../src/services/playToken');
const skr=require('../src/services/skrToken');
const {TOKEN_PROGRAM_ID}=require('@solana/spl-token');
process.env.BATTLECITY_SKR_MINT='SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3';
process.env.BATTLECITY_SKR_DECIMALS='6';
const rate=()=>({solUsd:'200',skrUsd:'0.02',playUsd:'0.001',fetchedAt:Date.now(),expiresAt:Date.now()+600000});
test('both token prices are exactly 20 percent below the SOL value, rounded only to atomic units',()=>{
  assert.equal(pricing.convertSol('0.01','skr',rate()),'80');
  assert.equal(pricing.convertSol('0.01','play',rate()),'1600');
  assert.equal(pricing.convertSol('0.000000001','play',{...rate(),solUsd:'100',playUsd:'0.03'}),'0.000003');
  assert.throws(()=>pricing.convertSol('0.01','play',{...rate(),expiresAt:0}),/expired/);
  assert.throws(()=>pricing.convertSol('-1','skr',rate()));
  assert.throws(()=>pricing.convertSol('1','play',{...rate(),playUsd:null}));
  assert.equal(play.config().mint,play.MINT);assert.equal(play.config().programId,TOKEN_PROGRAM_ID.toBase58());
});
test('per-item overrides, disabled prices and SOL base edits are deterministic without a provider request',async()=>{
  const s={tokenPricingMode:'sol-discounted',shopSkrOverrides:{shield:'12'},shopPlayPrices:{freeze:null}};
  assert.equal(await pricing.price(s,'shield','skr','0.01',rate()),'12');
  assert.equal(await pricing.price(s,'freeze','play','0.01',rate()),null);
  assert.equal(await pricing.price(s,'speed','play',null,rate()),null);
  assert.equal(await pricing.price(s,'speed','skr','0.02',rate()),'160');
  assert.equal(await pricing.price(s,'speed','play','0.02',rate()),'3200');
});
test('all players share one single-flight market batch for ten minutes',async(t)=>{
  let now=Date.now(),calls=0;
  t.mock.method(Date,'now',()=>now);
  t.mock.method(globalThis,'fetch',async(url)=>{
    calls++;assert.ok(String(url).startsWith('https://api.jup.ag/price/v3?ids='));
    return {ok:true,text:async()=>JSON.stringify({
      [pricing.SOL_MINT]:{usdPrice:200,blockId:10},[skr.config().mint]:{usdPrice:0.02,blockId:10},[play.MINT]:{usdPrice:0.001,blockId:10}})};
  });
  const results=await Promise.all(Array.from({length:30},()=>pricing.market()));
  assert.equal(calls,1);assert.ok(results.every(r=>r===results[0]));
  now+=599999;await pricing.market();assert.equal(calls,1);
  now++;await pricing.market();assert.equal(calls,2);
  now+=600000;
  t.mock.method(globalThis,'fetch',async()=>({ok:true,text:async()=>JSON.stringify({[pricing.SOL_MINT]:{usdPrice:200},[skr.config().mint]:{usdPrice:0.02}})}));
  const partial=await pricing.market();assert.equal(pricing.convertSol('0.01','skr',partial),'80');
  assert.throws(()=>pricing.convertSol('0.01','play',partial));
  now+=600000;let failures=0;
  t.mock.method(globalThis,'fetch',async()=>{failures++;return {ok:false};});
  await assert.rejects(pricing.market());await assert.rejects(pricing.market());
  assert.equal(failures,1,'provider failures cannot cause per-player retry storms');
});
