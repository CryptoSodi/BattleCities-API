import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test, { beforeEach, afterEach } from 'node:test';
const require = createRequire(import.meta.url);
const oauth = require('../src/services/nativeOAuth');
const flows = require('../src/stores/nativeOAuthStore');
const sessions = require('../src/stores/sessionStore');
const x = require('../src/services/xOAuth');
const discord = require('../src/services/discordOAuth');
const links = require('../src/stores/xConnectionStore');
const discordLinks = require('../src/stores/discordVerificationStore');
const swaps = require('../src/services/skrSwap');
const { Keypair, TransactionMessage, VersionedTransaction, SystemProgram } = require('@solana/web3.js');
let root;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'battlecities-native-'));
  process.env.NODE_ENV = 'test'; process.env.BATTLECITY_STORAGE_MODE = 'local';
  process.env.BATTLECITY_NATIVE_OAUTH_DIR = root;
  process.env.BATTLECITY_SWAP_EXECUTIONS_DIR = path.join(root, 'swaps');
  process.env.BATTLECITY_NATIVE_OAUTH_RETURN_URLS = 'battlecities://social';
  process.env.JUPITER_API_KEY = 'test-api-key'; process.env.BATTLECITY_SWAP_QUOTE_SECRET = 'test-swap-secret-'.repeat(4);
  process.env.BATTLECITY_SKR_MINT = Keypair.generate().publicKey.toBase58(); process.env.BATTLECITY_SKR_DECIMALS = '6';
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

test('native social states are opaque, provider-bound, owner-only and single use', async (t) => {
  t.mock.method(x, 'isConfigured', () => true);
  t.mock.method(x, 'createAuthorizationUrl', (_origin, _player, _session, options) => `https://x.com/auth?state=${options.state}`);
  t.mock.method(sessions, 'readSession', async () => ({ playerId: 'ply-test' }));
  t.mock.method(x, 'completeNative', async () => ({ id: 'x-user', username: 'Commander' }));
  const linked = t.mock.method(links, 'linkAccount', async () => ({ ok: true }));
  const flow = await oauth.start('x', { id: 'ply-test' }, 'private-session', 'https://api.battlecities.com', 'battlecities://social');
  assert.equal(flow.authorizationUrl.includes('private-session'), false);
  assert.equal(await flows.readStatus(flow.flowId, 'ply-other'), null);
  assert.equal(await flows.consume(flow.flowId, 'discord'), null);
  const req = new Request(`https://api.battlecities.com/api/integrations/x/oauth/callback?state=native.${flow.flowId}&code=valid`);
  const results = await Promise.all([oauth.callback('x', req), oauth.callback('x', req)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [302, 400]);
  assert.equal(linked.mock.callCount(), 1);
  assert.equal((await flows.readStatus(flow.flowId, 'ply-test')).status, 'completed');
  const stored = await fs.readFile(path.join(root, (await fs.readdir(root))[0]), 'utf8');
  assert.equal(stored.includes('private-session'), false);
  assert.throws(() => oauth.returnUrl('https://attacker.example'), /not allowed/);
});

test('native linking fails after logout during exchange and permits Discord without browser cookies', async (t) => {
  t.mock.method(discord, 'isConfigured', () => true);
  t.mock.method(discord, 'createAuthorizationUrl', () => 'https://discord.com/auth');
  let live = true;
  t.mock.method(sessions, 'readSession', async () => live ? { playerId: 'ply-test' } : null);
  t.mock.method(discord, 'completeNative', async () => { live = false; return { id: 'discord-user', username: 'Commander' }; });
  const linked = t.mock.method(discordLinks, 'verifyDiscordAccount', async () => ({ ok: true }));
  const flow = await oauth.start('discord', { id: 'ply-test' }, 'private-session', 'https://api.battlecities.com');
  const request = new Request(`https://api.battlecities.com/callback?state=native.${flow.flowId}&code=valid`);
  assert.equal((await oauth.callback('discord', request)).status, 200);
  assert.equal((await flows.readStatus(flow.flowId, 'ply-test')).status, 'failed');
  assert.equal(linked.mock.callCount(), 0);
  live = true;
  t.mock.method(discord, 'completeNative', async () => ({ id: 'discord-user', username: 'Commander' }));
  const next = await oauth.start('discord', { id: 'ply-test' }, 'private-session', 'https://api.battlecities.com');
  await oauth.callback('discord', new Request(`https://api.battlecities.com/callback?state=native.${next.flowId}&code=valid`));
  assert.equal((await flows.readStatus(next.flowId, 'ply-test')).status, 'completed');
  assert.equal(linked.mock.callCount(), 1);
});

function transaction(wallet, lamports = 10n) {
  return new VersionedTransaction(new TransactionMessage({ payerKey: wallet.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: Keypair.generate().publicKey, lamports })]
  }).compileToV0Message());
}
test('swap execution binds the wallet signature to the exact quoted transaction', async (t) => {
  const wallet = Keypair.generate(), tx = transaction(wallet);
  const player = { id: 'ply-test', provider: 'wallet', walletAddress: wallet.publicKey.toBase58() };
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, init });
    if (init.method === 'POST') return Response.json({ status: 'Success', code: 0, signature: '4'.repeat(88) });
    const query = new URL(url).searchParams;
    return Response.json({ requestId: 'order-one', transaction: Buffer.from(tx.serialize()).toString('base64'),
      inputMint: query.get('inputMint'), outputMint: query.get('outputMint'), inAmount: query.get('amount'), outAmount: '1000000' });
  });
  const quote = await swaps.quote(player, { from: 'sol', amount: '0.1' });
  assert.equal(quote.inAmount, '100000000');
  await assert.rejects(swaps.execute(player, { quoteToken: quote.quoteToken, signedTransaction: quote.transaction }), /signature/);
  tx.sign([wallet]);
  const signedTransaction = Buffer.from(tx.serialize()).toString('base64');
  await assert.rejects(swaps.execute({ ...player, id: 'ply-other' }, { quoteToken: quote.quoteToken, signedTransaction }), /another wallet/);
  await assert.rejects(swaps.execute(player, { quoteToken: quote.quoteToken + 'x', signedTransaction }), /Invalid swap quote/);
  const changed = transaction(wallet, 999n); changed.sign([wallet]);
  await assert.rejects(swaps.execute(player, { quoteToken: quote.quoteToken, signedTransaction: Buffer.from(changed.serialize()).toString('base64') }), /differs/);
  assert.equal((await swaps.execute(player, { quoteToken: quote.quoteToken, signedTransaction })).ok, true);
  assert.equal(await require('../src/stores/swapExecutionStore').isVerified(player.id, '4'.repeat(88)), true);
  assert.equal(await require('../src/stores/swapExecutionStore').isVerified('ply-other', '4'.repeat(88)), false);
  assert.equal(requests.filter((r) => r.init.method === 'POST').length, 1);
  assert.equal(JSON.parse(requests.at(-1).init.body).requestId, 'order-one');
  await assert.rejects(swaps.quote(player, { from: 'sol', amount: '-1' }));
  await assert.rejects(swaps.quote(player, { from: 'sol', amount: '1', slippageBps: 9999 }), /Slippage/);
  const reverse = await swaps.quote(player, { from: 'skr', amount: '1.25' });
  assert.equal(reverse.inAmount, '1250000');
  assert.equal(reverse.inputMint, process.env.BATTLECITY_SKR_MINT);
  assert.equal(reverse.outputMint, 'So11111111111111111111111111111111111111112');
});
