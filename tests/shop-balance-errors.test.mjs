import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } = require('@solana/spl-token');
const shop = require('../src/services/shopPaymentService');
const config = require('../src/services/competitionConfig');
const pricing = require('../src/services/shopTokenPricing');
const skr = require('../src/services/skrToken');
const play = require('../src/services/playToken');

test('failed quote identifies only confirmed shortages for its payment currency', async t => {
  const wallet = Keypair.generate().publicKey;
  const player = { id: 'ply-balance-test', provider: 'wallet', walletAddress: wallet.toBase58() };
  process.env.BATTLECITY_SHOP_QUOTE_SECRET = 'test-shop-secret-'.repeat(4);
  process.env.BATTLECITY_SKR_MINT = Keypair.generate().publicKey.toBase58();
  process.env.BATTLECITY_SKR_DECIMALS = '6';
  process.env.BATTLECITY_SKR_TOKEN_PROGRAM = TOKEN_PROGRAM_ID.toBase58();
  let scenario = {}, source = null, destination = null, diagnostics = 0;
  t.mock.method(config, 'get', async () => config.defaults());
  t.mock.method(pricing, 'price', async () => '57');
  t.mock.method(skr, 'validateMint', async () => ({ decimals: 6 }));
  t.mock.method(Connection.prototype, 'getLatestBlockhash', async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }));
  t.mock.method(Connection.prototype, 'simulateTransaction', async () => ({ value: { err: scenario.simulationOk ? null : { InstructionError: [1, 'failure'] } } }));
  t.mock.method(Connection.prototype, 'getBalance', async () => { diagnostics++; if (scenario.walletError) throw new Error('RPC unavailable'); return scenario.sol ?? 20000000; });
  t.mock.method(Connection.prototype, 'getFeeForMessage', async () => { if (scenario.feeError) throw new Error('RPC unavailable'); return { value: scenario.fee ?? 5000 }; });
  t.mock.method(Connection.prototype, 'getAccountInfo', async address => {
    if (source && address.equals(source)) { if (scenario.sourceError) throw new Error('RPC unavailable'); return scenario.noSource ? null : {}; }
    if (destination && address.equals(destination)) return scenario.noDestination ? null : {};
    throw new Error('Unexpected token account');
  });
  t.mock.method(Connection.prototype, 'getTokenAccountBalance', async address => {
    assert.ok(address.equals(source), 'inspect the quoted source account, not the sum of unrelated token accounts');
    if (scenario.tokenError) throw new Error('RPC unavailable');
    return { value: { amount: scenario.token ?? '57000000' } };
  });
  t.mock.method(Connection.prototype, 'getMinimumBalanceForRentExemption', async size => { assert.equal(size, 165); return 2000000; });
  async function failure(currency, values) {
    scenario=values;
    if(currency==='sol')source=destination=null;
    else {
      const mint=new PublicKey(currency==='skr'?process.env.BATTLECITY_SKR_MINT:play.MINT);
      source=getAssociatedTokenAddressSync(mint,wallet,false,TOKEN_PROGRAM_ID);
      destination=getAssociatedTokenAddressSync(mint,new PublicKey(shop.TREASURY),false,TOKEN_PROGRAM_ID);
    }
    try { await shop.createQuote(player,{itemId:'fuel-one',currency,walletAddress:wallet.toBase58()}); }
    catch(error) { return error.message; }
    assert.fail('A failing simulation must not produce a quote');
  }
  assert.equal(await failure('skr',{token:'56999999'}),'Not enough SKR in the payment account for this purchase.');
  assert.equal(await failure('play',{token:'0'}),'Not enough PLAY in the payment account for this purchase.');
  assert.equal(await failure('sol',{sol:9999999}),'Not enough SOL to cover the purchase and network fees.');
  assert.equal(await failure('skr',{sol:4999}),'Not enough SOL for network fees.');
  assert.equal(await failure('skr',{token:'1',sol:4999}),'Not enough SKR in the payment account for this purchase. Not enough SOL for network fees.');
  assert.equal(await failure('skr',{noSource:true}),'Not enough SKR in the payment account for this purchase.');
  assert.equal(await failure('skr',{noDestination:true,sol:1000000}),'Not enough SOL for network fees and token account setup.');
  assert.equal(await failure('skr',{}),'The payment could not be prepared. Please try again.');
  assert.equal(await failure('skr',{walletError:true,sourceError:true}),'The payment could not be prepared. Please try again.');
  assert.equal(await failure('skr',{sol:0,feeError:true}),'The payment could not be prepared. Please try again.');
  scenario={simulationOk:true,sol:0,token:'0'};
  const previousDiagnostics=diagnostics;
  const quote=await shop.createQuote(player,{itemId:'fuel-one',currency:'skr',walletAddress:wallet.toBase58()});
  assert.equal(quote.currency,'skr');assert.equal(diagnostics,previousDiagnostics,'successful quotes do not run failure diagnostics');
});

test('quote endpoint returns the specific preparation error to the Shop', async t => {
  const identity=require('../dist/src/services/sessionIdentity');
  const sessions=require('../dist/src/stores/sessionStore');
  const players=require('../dist/src/stores/playerStore');
  const limiter=require('../dist/src/services/rateLimiter');
  const payment=require('../dist/src/services/shopPaymentService');
  const route=require('../dist/src/routes/economy/purchaseQuote');
  const player={id:'ply-quote-test',provider:'wallet'};
  t.mock.method(identity,'resolveSession',()=> 'fixture-session');
  t.mock.method(sessions,'readSession',async()=>({playerId:player.id}));
  t.mock.method(players,'readPlayerForSession',async()=>player);
  t.mock.method(limiter,'allow',()=>true);
  t.mock.method(payment,'createQuote',async()=>{throw new Error('Not enough SKR in the payment account for this purchase.');});
  const response=await route.POST(new Request('https://api.battlecities.com/api/economy/purchase/quote',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({itemId:'fuel-one',currency:'skr'})}));
  assert.equal(response.status,400);
  assert.deepEqual(await response.json(),{ok:false,statusText:'Not enough SKR in the payment account for this purchase.'});
});
