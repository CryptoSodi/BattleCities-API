import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test, { beforeEach, afterEach } from 'node:test';
const require = createRequire(import.meta.url);
const { Keypair, Connection, PublicKey, Transaction, SystemProgram, ComputeBudgetInstruction, VersionedTransaction } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } = require('@solana/spl-token');
const store = require('../src/stores/competitionStore');
const config = require('../src/services/competitionConfig');
const competitions = require('../src/services/competitions');
const matches = require('../src/stores/matchResultStore');
const trading = require('../src/stores/tradingStore');
const players = require('../src/stores/playerStore');
const shop = require('../src/services/shopPaymentService');
const rpc = require('../src/services/solanaRpc');
const skr = require('../src/services/skrToken');
const delivery = require('../src/services/rankingPayoutDelivery');
let root;
const walletKeypair = Keypair.generate();
const wallet = walletKeypair.publicKey.toBase58();
const player = { id: 'ply-ranking-test', provider: 'wallet', walletAddress: wallet, displayName: 'Test Commander' };
const season = { id: 'season-1', name: 'Season 1', number: 1, startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-11-01T00:00:00.000Z' };
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'battlecities-competitions-'));
  process.env.NODE_ENV = 'test'; process.env.BATTLECITY_STORAGE_MODE = 'local';
  process.env.BATTLECITY_COMPETITIONS_FILE = path.join(root, 'competitions.json');
  for (const [env, dir] of Object.entries({ MATCH: 'matches', SEASON: 'seasons', TRADING: 'trading', PLAYER: 'players', ECONOMY: 'economy', LEDGER: 'ledger' })) {
    process.env[`BATTLECITY_${env}_DIR`] = path.join(root, dir);
    await fs.mkdir(path.join(root, dir));
  }
  process.env.BATTLECITY_SHOP_PAYMENTS_FILE = path.join(root, 'payments.json');
  process.env.BATTLECITY_SKR_MINT = Keypair.generate().publicKey.toBase58();
  process.env.BATTLECITY_SKR_DECIMALS = '6'; process.env.BATTLECITY_SKR_TOKEN_PROGRAM = TOKEN_PROGRAM_ID.toBase58();
  process.env.BATTLECITY_SHOP_QUOTE_SECRET = 'test-shop-secret-'.repeat(4);
  await fs.writeFile(path.join(root, 'seasons', 'seasons.json'), JSON.stringify([season]));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
async function record(id, overrides = {}) {
  const value = { id, playerId: player.id, provider: 'wallet', walletAddress: wallet, displayName: player.displayName,
    seasonId: season.id, mode: 'single', score: 1000, gamePoints: 100, validationStatus: 'accepted', prizeReview: { decision: 'accepted' }, createdAt: '2026-10-05T10:00:00.000Z', ...overrides };
  await fs.writeFile(path.join(root, 'matches', `${id}.json`), JSON.stringify(value)); return value;
}
function settings() { return { ...config.defaults(), seasonPass: { enabled: true, skrPrice: '500', solPrice: '0.1' },
  cycle: { enabled: true, prizes: [{ fromRank: 1, toRank: 1, amount: '10' }] } }; }

test('admin settings validate prices, token precision, and overlapping prize tiers', async () => {
  assert.equal((await config.get()).seasonPass.enabled, false);
  await config.update(settings(), 'ply-admin');
  assert.equal((await config.get()).seasonPass.skrPrice, '500');
  assert.throws(() => config.validate({ ...settings(), seasonPass: { enabled: true, skrPrice: '-1', solPrice: '0.1' } }));
  assert.throws(() => config.validate({ ...settings(), cycle: { enabled: true, prizes: [
    { fromRank: 1, toRank: 3, amount: '1' }, { fromRank: 3, toRank: 4, amount: '2' }] } }), /overlap/);
  assert.throws(() => skr.atomic('1.0000001', 6), /precision/);
  assert.equal(skr.atomic('9000000000.123456', 6), 9000000000123456n);
});

test('personal ranks match displayed positions when scores tie in all-time and season standings', async () => {
  for (const suffix of ['c','b','a']) {
    const id='ply-tie-'+suffix;
    await record('tie-'+suffix,{playerId:id,displayName:'Tied '+suffix,gamePoints:suffix==='a'?200:100});
    await store.grantPass(id,season,'tie-pass-'+suffix,'2026-10-05T12:00:00Z');
  }
  for (const scope of [null,season.id]) {
    const board=await matches.getLeaderboard(scope,20);
    assert.deepEqual(board.map(row=>[row.playerId,row.rank]),[['ply-tie-a',1],['ply-tie-b',2],['ply-tie-c',3]]);
    for (const row of board) {
      const personal=await matches.getPlayerRank(row.playerId,scope);
      assert.equal(personal.rank,row.rank);
      assert.equal(personal.totalPoints,row.totalPoints);
      assert.equal(personal.matches,row.matches);
    }
  }
  const cycle=await matches.getLeaderboardInWindow(null,'2026-10-05T10:00:00Z','2026-10-05T10:30:00Z',10,'ply-tie-c');
  assert.equal(cycle.find(row=>row.playerId==='ply-tie-c').rank,3);
});

test('buying a pass includes every eligible earlier season match and preserves cycle eligibility', async () => {
  await record('old', { createdAt: '2026-10-01T00:01:00.000Z' });
  await record('recent');
  await record('rejected', { validationStatus: 'rejected', gamePoints: 9000 });
  await record('guest', { provider: 'guest', gamePoints: 9000 });
  await record('outside', { createdAt: season.endsAt, gamePoints: 9000 });
  assert.deepEqual(await matches.getLeaderboard(season.id), []);
  assert.equal((await matches.getLeaderboardInWindow(null, '2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z'))[0].totalPoints, 100);
  const pass = await store.grantPass(player.id, season, 'payment-one', '2026-10-05T12:00:00Z');
  assert.equal(pass.eligibleFrom, season.startsAt);
  assert.equal((await matches.getLeaderboard(season.id))[0].totalPoints, 200);
  assert.equal((await matches.getPlayerRank(player.id, season.id)).totalPoints, 200);
  await record('future-match', { createdAt: '2026-10-06T12:00:00.000Z', gamePoints: 50 });
  assert.equal((await matches.getLeaderboard(season.id))[0].totalPoints, 250);
  const retry = await store.grantPass(player.id, season, 'payment-one', '2026-10-06T12:00:00Z');
  assert.equal(retry.purchasedAt, pass.purchasedAt);
  await assert.rejects(store.grantPass('ply-other', season, 'payment-one', '2026-10-05T12:00:00Z'), /already used/);
  await assert.rejects(store.grantPass(player.id, season, 'late-payment', season.endsAt), /outside/);
});

test('SOL pass purchases verify exact transfer amounts and survive repeated verification', async (t) => {
  const current = { ...season, startsAt: new Date(Date.now() - 86400000).toISOString(), endsAt: new Date(Date.now() + 86400000).toISOString() };
  await fs.writeFile(path.join(root, 'seasons', 'seasons.json'), JSON.stringify([current]));
  await config.update(settings(), 'ply-admin');
  t.mock.method(Connection.prototype, 'getLatestBlockhash', async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }));
  t.mock.method(Connection.prototype, 'simulateTransaction', async () => ({ value: { err: null } }));
  const quote = await shop.createQuote(player, { itemId: 'season-pass', currency: 'sol', seasonId: current.id });
  const payload = JSON.parse(Buffer.from(quote.quoteToken.split('.')[0], 'base64url'));
  assert.equal(payload.amountAtomic, '100000000');
  let amount = 1;
  t.mock.method(rpc, 'getTransaction', async () => ({ blockTime: Math.floor(Date.now() / 1000), meta: { err: null }, transaction: { message: {
    accountKeys: [{ pubkey: wallet, signer: true }], instructions: [{ program: 'system', parsed: { type: 'transfer', info: {
      source: wallet, destination: shop.TREASURY, lamports: amount } } }, { program: 'spl-memo', parsed: `BATC-SHOP-V1:${payload.id}` }]
  } } }));
  const signature = '3'.repeat(88);
  await assert.rejects(shop.verifyPurchase(player, { quoteToken: quote.quoteToken, signature }), /does not match/);
  assert.equal(await store.getPass(player.id, current.id), null);
  amount = 100000000;
  assert.equal((await shop.verifyPurchase(player, { quoteToken: quote.quoteToken, signature })).seasonPass.eligibleFrom, current.startsAt);
  assert.equal((await shop.verifyPurchase(player, { quoteToken: quote.quoteToken, signature })).statusText, 'PURCHASE ALREADY VERIFIED');
});

async function signedQuote(t) {
  const current = { ...season, startsAt: new Date(Date.now() - 86400000).toISOString(), endsAt: new Date(Date.now() + 86400000).toISOString() };
  await fs.writeFile(path.join(root, 'seasons', 'seasons.json'), JSON.stringify([current]));
  await config.update(settings(), 'ply-admin');
  t.mock.method(Connection.prototype, 'getLatestBlockhash', async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }));
  t.mock.method(Connection.prototype, 'simulateTransaction', async () => ({ value: { err: null } }));
  t.mock.method(Connection.prototype, 'getSignatureStatuses', async () => ({ value: [null] }));
  const quote = await shop.createQuote(player, { itemId: 'season-pass', currency: 'sol', seasonId: current.id });
  const tx = Transaction.from(Buffer.from(quote.transaction, 'base64'));
  tx.sign(walletKeypair);
  return { quote, tx, input: { quoteToken: quote.quoteToken, signedTransaction: tx.serialize().toString('base64') } };
}

test('checkout broadcasts only the exact server message signed by the authenticated wallet', async (t) => {
  const { tx, input } = await signedQuote(t);
  const bs58Module = require('bs58'), bs58 = bs58Module.default || bs58Module;
  const signature = bs58.encode(tx.signature);
  let sends = 0;
  t.mock.method(Connection.prototype, 'sendRawTransaction', async bytes => {
    sends++; assert.deepEqual(bytes, tx.serialize()); return signature;
  });
  assert.equal((await shop.submitPurchase(player, input)).signature, signature);
  assert.equal(sends, 1);
  tx.add(SystemProgram.transfer({ fromPubkey: walletKeypair.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  tx.sign(walletKeypair);
  await assert.rejects(shop.submitPurchase(player, { ...input, signedTransaction: tx.serialize().toString('base64') }), /does not match/);
  await assert.rejects(shop.submitPurchase({ ...player, walletAddress: Keypair.generate().publicKey.toBase58() }, input), /wallet/i);
  assert.equal(sends, 1);
});

test('Phantom-compatible quotes bind an explicit fee and preserve their legacy wire message', async (t) => {
  const { quote } = await signedQuote(t);
  const unsigned = Buffer.from(quote.transaction, 'base64');
  const legacy = Transaction.from(unsigned);
  assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitLimit(legacy.instructions[0]).units, 250000);
  assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitPrice(legacy.instructions[1]).microLamports, 0n);
  const immutable = VersionedTransaction.deserialize(unsigned);
  assert.equal(immutable.version, 'legacy');
  immutable.sign([walletKeypair]);
  const bytes = Buffer.from(immutable.serialize());
  assert.deepEqual(bytes.subarray(65), unsigned.subarray(65));
  const bs58Module = require('bs58'), bs58 = bs58Module.default || bs58Module;
  const signature = bs58.encode(bytes.subarray(1,65));
  let sends = 0;
  t.mock.method(Connection.prototype, 'sendRawTransaction', async submitted => {
    sends++; assert.deepEqual(submitted, bytes); return signature;
  });
  assert.equal((await shop.submitPurchase(player, { quoteToken: quote.quoteToken, signedTransaction: bytes.toString('base64') })).signature, signature);
  assert.equal(sends, 1);
});

test('an uncertain broadcast retains its signature for reconciliation without a second payment', async (t) => {
  const { tx, input } = await signedQuote(t);
  const bs58Module = require('bs58'), bs58 = bs58Module.default || bs58Module;
  t.mock.method(Connection.prototype, 'sendRawTransaction', async () => { throw new Error('Timeout after submission'); });
  const result = await shop.submitPurchase(player, input);
  assert.equal(result.pending, true);
  assert.equal(result.signature, bs58.encode(tx.signature));
  assert.equal(await store.getPass(player.id, season.id), null);
});

test('an unsigned quote cannot broadcast, and finalized expiry releases an unpaid receipt', async (t) => {
  const { quote, input } = await signedQuote(t);
  let sends=0;
  t.mock.method(Connection.prototype, 'sendRawTransaction', async () => {sends++;throw new Error();});
  await assert.rejects(shop.submitPurchase(player,{...input,signedTransaction:quote.transaction}), /does not match/);
  const now=Date.now();t.mock.method(Date,'now',()=>now+3600000);
  t.mock.method(rpc,'getTransaction',async()=>null);
  const connection={getSignatureStatuses:async()=>({value:[null]}),getBlockHeight:async()=>101};
  assert.equal((await shop.submitPurchase(player,input,connection)).terminal,true);
  assert.equal(sends,0);
});

test('late verification credits an on-time payment, and rejects a payment outside its original window', async (t) => {
  const { quote, input } = await signedQuote(t);
  const payload = JSON.parse(Buffer.from(quote.quoteToken.split('.')[0], 'base64url'));
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 3600000);
  let blockTime = Math.floor((payload.issuedAt + 10000) / 1000);
  t.mock.method(rpc, 'getTransaction', async () => ({ blockTime, meta: { err: null }, transaction: { message: {
    accountKeys: [{ pubkey: wallet, signer: true }], instructions: [{ program: 'system', parsed: { type: 'transfer', info: {
      source: wallet, destination: shop.TREASURY, lamports: 100000000 } } }, { program: 'spl-memo', parsed: `BATC-SHOP-V1:${payload.id}` }]
  } } }));
  let sends = 0;
  t.mock.method(Connection.prototype, 'sendRawTransaction', async () => { sends++; throw new Error(); });
  blockTime = Math.floor((payload.expiresAt + 120000) / 1000);
  const connection={getSignatureStatuses:async()=>({value:[null]}),getBlockHeight:async()=>101};
  assert.equal((await shop.submitPurchase(player, input,connection)).pending, true);
  assert.equal(sends, 0);
  blockTime = Math.floor((payload.issuedAt + 10000) / 1000);
  assert.equal((await shop.submitPurchase(player, input)).ok, true);
  assert.equal(sends, 0);
  const current = JSON.parse(await fs.readFile(path.join(root, 'seasons', 'seasons.json'), 'utf8'))[0];
  assert.equal((await store.getPass(player.id, season.id)).eligibleFrom, current.startsAt);
});

test('payout retries resend persisted bytes and stop after confirmation', async (t) => {
  const storage = require('../src/config/storageConfig');
  process.env.BATTLECITY_LEADERBOARD_REWARDS_ENABLED = '1';
  t.mock.method(storage, 'hasDatabaseConfig', () => true);
  const payout = { id: 'payout-test', status: 'prepared', delivery: { signature: 'known-signature',
    rawTransaction: Buffer.from('persisted signed transaction').toString('base64'), blockhash: 'known-blockhash', lastValidBlockHeight: 500 } };
  t.mock.method(store, 'getPayout', async () => payout);
  t.mock.method(store, 'finishPayout', async (_id, _signature, error) => { payout.status = error ? 'failed' : 'paid'; return payout; });
  let attempt = 0;
  const send = t.mock.fn(async (bytes) => {
    assert.equal(bytes.toString(), 'persisted signed transaction');
    if (attempt++ === 0) throw new Error('Simulated timeout after send');
    return 'known-signature';
  });
  const connection = { getSignatureStatuses: async () => ({ value: [null] }), getBlockHeight: async () => 100,
    sendRawTransaction: send, confirmTransaction: async () => ({ value: { err: null } }) };
  await assert.rejects(delivery.deliver(payout.id, connection), /timeout/);
  assert.equal((await delivery.deliver(payout.id, connection)).status, 'paid');
  await delivery.deliver(payout.id, connection);
  assert.equal(send.mock.callCount(), 2);
});

test('payout eligibility excludes pending client submissions', async () => {
  await record('accepted'); await record('pending', { validationStatus: 'pending', gamePoints: 1000 });
  const period = competitions.cycleAt(Date.parse('2026-10-05T10:00:00Z'));
  assert.equal((await competitions.board(period))[0].totalPoints, 1100);
  assert.equal((await competitions.board(period, true))[0].totalPoints, 100);
  const result = await matches.submitResult(player, season, { score: 100000, validationStatus: 'accepted' });
  assert.equal(result.validationStatus, 'pending');
  assert.equal(result.prizeReview, undefined);
  await record('legacy-accepted', { prizeReview: undefined, gamePoints: 9999 });
  assert.equal((await competitions.board(period, true))[0].totalPoints, 100);
});

test('admin prize review is required, audited and final', async () => {
  const reviews = require('../src/stores/matchPrizeReviewStore');
  await record('mtc-review-one', { prizeReview: undefined, validationStatus: 'pending' });
  assert.equal((await reviews.list()).length, 1);
  await reviews.review('mtc-review-one', 'accepted', 'Verified against trusted match evidence.', 'ply-admin');
  assert.equal((await reviews.list()).length, 0);
  assert.equal((await competitions.board(competitions.cycleAt(Date.parse('2026-10-05T10:00:00Z')), true))[0].totalPoints, 100);
  await assert.rejects(reviews.review('mtc-review-one', 'rejected', 'Different conclusion.', 'ply-admin'), /already final/);
  await assert.rejects(reviews.review('../escape', 'accepted', 'Invalid file path.', 'ply-admin'), /Invalid match/);
});

test('closing a cycle freezes standings and allocates a prize once under retries', async () => {
  await record('accepted');
  const period = await store.ensurePeriod({ ...competitions.cycleAt(Date.parse('2026-10-05T10:00:00Z')),
    policy: { ...settings().cycle, token: skr.config() } });
  await Promise.all([competitions.close(period, Date.parse('2026-10-05T10:36:00Z')), competitions.close(period, Date.parse('2026-10-05T10:36:00Z'))]);
  assert.equal((await store.listPayouts({ periodId: period.id })).length, 1);
  await record('late', { gamePoints: 500 });
  assert.equal((await store.getPeriod(period.id)).rows[0].totalPoints, 100);
  const payout = (await store.listPayouts({ periodId: period.id }))[0];
  assert.equal(payout.amount, '10');
  const first = { signature: 'signature-one', rawTransaction: 'private-bytes', lastValidBlockHeight: 100 };
  await Promise.all([store.preparePayout(payout.id, null, first), store.preparePayout(payout.id, null, { signature: 'signature-two' })]);
  assert.equal((await store.getPayout(payout.id)).delivery.signature, first.signature);
  await store.finishPayout(payout.id, 'wrong-signature');
  assert.equal((await store.getPayout(payout.id)).status, 'prepared');
  await store.finishPayout(payout.id, first.signature);
  await store.preparePayout(payout.id, first.signature, { signature: 'duplicate' });
  assert.equal((await store.getPayout(payout.id)).status, 'paid');
  assert.equal(JSON.stringify(competitions.publicPayout(await store.getPayout(payout.id))).includes('private-bytes'), false);
});

test('historical import never allocates newly enabled prizes retroactively', async () => {
  await config.update(settings(), 'ply-admin'); await record('accepted');
  const cycle = competitions.cycleAt(Date.parse('2026-10-05T10:00:00Z'));
  const saved = await competitions.historicalCycle(cycle.id, Date.parse('2026-10-05T11:00:00Z'));
  assert.equal(saved.rows.length, 1);
  assert.equal((await store.listPayouts()).length, 0);
  await assert.rejects(competitions.historicalCycle('cycle:../../../file'));
  await assert.rejects(competitions.historicalCycle(competitions.cycleAt().id), /completed/);
});

test('an uncertain transfer is reused until finalized expiry and checked again before replacement', async () => {
  const d = { signature: 'one', lastValidBlockHeight: 100 };
  const connection = { getSignatureStatuses: async () => ({ value: [null] }), getBlockHeight: async () => 90 };
  assert.equal(await delivery.deliveryState(connection, d), 'retry');
  connection.getBlockHeight = async () => 101;
  let calls = 0;
  connection.getSignatureStatuses = async () => ({ value: [++calls === 1 ? null : { err: null, confirmationStatus: 'confirmed' }] });
  assert.equal(await delivery.deliveryState(connection, d), 'paid');
  connection.getSignatureStatuses = async () => ({ value: [{ err: null, confirmationStatus: 'processed' }] });
  assert.equal(await delivery.deliveryState(connection, d), 'wait');
  connection.getSignatureStatuses = async () => ({ value: [null] });
  assert.equal(await delivery.deliveryState(connection, d), 'replace');
});

test('trading rankings aggregate verified swaps within the season and ignore mocked volume', async () => {
  const p = await players.findOrCreateWalletPlayer(wallet);
  for (const [i, verified, at, amount] of [[1,true,'2026-10-05T10:00:00Z',25], [2,true,'2026-10-05T11:00:00Z',15],
    [3,false,'2026-10-05T11:00:00Z',9000], [4,true,'2026-09-05T11:00:00Z',9000]]) {
    await fs.writeFile(path.join(root, 'trading', `${i}.json`), JSON.stringify({ playerId: p.id, verified, createdAt: at, volumeUsd: amount }));
  }
  const board = await trading.getLeaderboard(season.startsAt, season.endsAt);
  assert.equal(board[0].totalPoints, 40); assert.equal(board[0].matches, 2);
  process.env.BATTLECITY_SWAP_VERIFY_MODE = 'mock'; process.env.NODE_ENV = 'production';
  assert.equal(trading.getVerifyMode(), 'rpc'); process.env.NODE_ENV = 'test';
});

test('SKR season pass checkout honors the signed price and grants one full-season entitlement', async (t) => {
  const now = Date.now();
  const liveSeason = { ...season, startsAt: new Date(now - 86400000).toISOString(), endsAt: new Date(now + 86400000).toISOString() };
  await fs.writeFile(path.join(root, 'seasons', 'seasons.json'), JSON.stringify([liveSeason]));
  await config.update(settings(), 'ply-admin');
  t.mock.method(Connection.prototype, 'getLatestBlockhash', async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }));
  t.mock.method(Connection.prototype, 'simulateTransaction', async () => ({ value: { err: null } }));
  t.mock.method(skr, 'validateMint', async () => ({ decimals: 6 }));
  const quoted = await shop.createQuote(player, { itemId: 'season-pass', currency: 'skr', walletAddress: wallet });
  const payload = JSON.parse(Buffer.from(quoted.quoteToken.split('.')[0], 'base64url'));
  assert.equal(payload.amountAtomic, '500000000');
  const mint = new PublicKey(process.env.BATTLECITY_SKR_MINT);
  const signature = '2'.repeat(88);
  t.mock.method(rpc, 'getTransaction', async () => ({ blockTime: Math.floor(Date.now() / 1000), meta: { err: null }, transaction: { message: {
    accountKeys: [{ pubkey: wallet, signer: true }], instructions: [{ programId: TOKEN_PROGRAM_ID.toBase58(), parsed: { type: 'transferChecked', info: {
      authority: wallet, source: getAssociatedTokenAddressSync(mint, new PublicKey(wallet)).toBase58(),
      destination: getAssociatedTokenAddressSync(mint, new PublicKey(shop.TREASURY)).toBase58(), mint: mint.toBase58(),
      tokenAmount: { amount: payload.amountAtomic, decimals: 6 } } } },
      { program: 'spl-memo', parsed: `BATC-SHOP-V1:${payload.id}` }] } } }));
  await config.update({ ...settings(), seasonPass: { enabled: true, skrPrice: '900', solPrice: '0.2' } }, 'ply-admin');
  const result = await shop.verifyPurchase(player, { quoteToken: quoted.quoteToken, signature });
  assert.equal(result.seasonPass.eligibleFrom, liveSeason.startsAt);
  const retry = await shop.verifyPurchase(player, { quoteToken: quoted.quoteToken, signature });
  assert.equal(retry.statusText, 'PURCHASE ALREADY VERIFIED');
  await assert.rejects(shop.verifyPurchase({ ...player, id: 'ply-another' }, { quoteToken: quoted.quoteToken, signature }), /already used/);
  await assert.rejects(shop.createQuote(player, { itemId: 'season-pass', currency: 'skr', walletAddress: wallet }), /already owned/);
});

test('PLAY checkout binds the verified mint, discounted SOL value and exact approved price across admin edits', async(t)=>{
  const pricing=require('../src/services/shopTokenPricing'), play=require('../src/services/playToken');
  const configured={...settings(),tokenPricingMode:'sol-discounted',shopSolPrices:{...config.defaults().shopSolPrices,shield:'0.02'}};
  await config.update(configured,'ply-admin');
  t.mock.method(globalThis,'fetch',async()=>({ok:true,text:async()=>JSON.stringify({
    [pricing.SOL_MINT]:{usdPrice:200},[process.env.BATTLECITY_SKR_MINT]:{usdPrice:0.02},[play.MINT]:{usdPrice:0.001}})}));
  t.mock.method(Connection.prototype,'getLatestBlockhash',async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100}));
  t.mock.method(Connection.prototype,'simulateTransaction',async()=>({value:{err:null}}));
  t.mock.method(skr,'validateMint',async(connection,token)=>{assert.equal(token.mint,play.MINT);assert.equal(token.decimals,6);return {decimals:6};});
  const quoted=await shop.createQuote(player,{itemId:'shield',currency:'play',walletAddress:wallet});
  const payload=JSON.parse(Buffer.from(quoted.quoteToken.split('.')[0],'base64url'));
  assert.equal(quoted.currency,'play');assert.equal(payload.tokenMint,play.MINT);assert.equal(payload.amountAtomic,'3200000000');
  let paymentMint=new PublicKey(process.env.BATTLECITY_SKR_MINT);
  t.mock.method(rpc,'getTransaction',async()=>({blockTime:Math.floor(Date.now()/1000),meta:{err:null},transaction:{message:{
    accountKeys:[{pubkey:wallet,signer:true}],instructions:[{programId:TOKEN_PROGRAM_ID.toBase58(),parsed:{type:'transferChecked',info:{
      authority:wallet,source:getAssociatedTokenAddressSync(paymentMint,new PublicKey(wallet)).toBase58(),
      destination:getAssociatedTokenAddressSync(paymentMint,new PublicKey(shop.TREASURY)).toBase58(),mint:paymentMint.toBase58(),
      tokenAmount:{amount:payload.amountAtomic,decimals:6}}}}, {program:'spl-memo',parsed:`BATC-SHOP-V1:${payload.id}`}]
  }}}));
  const signature='3'.repeat(88);
  await assert.rejects(shop.verifyPurchase(player,{quoteToken:quoted.quoteToken,signature}));
  paymentMint=new PublicKey(play.MINT);
  await config.update({...configured,shopSolPrices:{...configured.shopSolPrices,shield:'0.04'}},'ply-admin');
  const result=await shop.verifyPurchase(player,{quoteToken:quoted.quoteToken,signature});
  assert.equal(result.account.inventory.shield,1);
  const again=await shop.verifyPurchase(player,{quoteToken:quoted.quoteToken,signature});
  assert.equal(again.statusText,'PURCHASE ALREADY VERIFIED');
  const ledger=require('../src/stores/ledgerStore');
  const entries=(await ledger.listEntriesForPlayer(player.id)).filter(e=>e.currency==='play');
  assert.equal(entries.length,1);assert.equal(entries[0].amount,-3200);
});
