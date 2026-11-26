import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const attempts = require('../src/stores/shopAttemptStore');
const shop = require('../src/services/shopPaymentService');
const players = require('../src/stores/playerStore');
const recovery = require('../src/services/shopRecovery');
const rpc = require('../src/services/solanaRpc');
const economy = require('../src/stores/economyStore');
const recoveryDatabase = process.env.BATTLECITY_SHOP_RECOVERY_TEST_DATABASE_URL || process.env.BATTLECITY_TEST_DATABASE_URL;

test('recovery registration validates quote authenticity and wallet ownership', () => {
  const previous = process.env.BATTLECITY_SHOP_QUOTE_SECRET;
  const secret = 'test-recovery-secret-32-characters-minimum';
  process.env.BATTLECITY_SHOP_QUOTE_SECRET = secret;
  const walletAddress = '7P5t1uh64Kxh524jz1EMDhQNsnd7DxZju5gfjRtqxYUM';
  const player = { id: 'ply-test', provider: 'wallet', walletAddress };
  const quote = { v: 2, id: crypto.randomUUID(), playerId: player.id, walletAddress,
    itemId: 'fuel-one', currency: 'sol', amountAtomic: '10000000', treasury: shop.TREASURY,
    tokenMint: shop.TOKEN_MINT, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    tokenDecimals: 6, network: shop.NETWORK, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 60000 };
  const encoded = Buffer.from(JSON.stringify(quote)).toString('base64url');
  const token = `${encoded}.${crypto.createHmac('sha256', secret).update(encoded).digest('base64url')}`;
  try {
    assert.equal(shop.validateRecoveryAttempt(player, { quoteToken: token }).quoteId, quote.id);
    assert.throws(() => shop.validateRecoveryAttempt({ ...player, id: 'ply-other' }, { quoteToken: token }), /does not match/);
    assert.throws(() => shop.validateRecoveryAttempt({ ...player, walletAddress: shop.TREASURY }, { quoteToken: token }), /wallet/);
    assert.throws(() => shop.validateRecoveryAttempt(player, { quoteToken: `${encoded}.invalid` }), /signature is invalid/);
    assert.throws(() => shop.validateRecoveryAttempt(player, { quoteToken: token, signature: 'bad' }), /signature/);
  } finally {
    if (previous === undefined) delete process.env.BATTLECITY_SHOP_QUOTE_SECRET;
    else process.env.BATTLECITY_SHOP_QUOTE_SECRET = previous;
  }
});

test('worker keeps uncertain results and resolves only verified or terminal payments', async t => {
  const make = (id, signature = null) => ({ quote_id: id, claim_id: 'lease', player_id: 'ply-1',
    wallet_address: 'wallet', quote_token: id, signature, check_count: 0 });
  const saved = [make('paid'), make('failed'), make('unknown'), make('rpc-error'), make('fallback', 'old-signature')];
  t.mock.method(attempts, 'claim', async () => saved);
  t.mock.method(players, 'readPlayer', async () => ({ id: 'ply-1', provider: 'wallet', walletAddress: 'wallet' }));
  const completions = [];
  t.mock.method(attempts, 'complete', async (item, status, signature) => { completions.push({ id: item.quote_id, status, signature }); });
  t.mock.method(shop, 'recoverPurchase', async (_player, input) => {
    if (input.quoteToken === 'paid') return { ok: true, account: {}, txHash: 'verified-signature' };
    if (input.quoteToken === 'failed') return { ok: false, terminal: true };
    if (input.quoteToken === 'rpc-error') throw new Error('RPC unavailable');
    if (input.quoteToken === 'fallback' && !input.signature) return { ok: true, account: {}, txHash: 'recovered-signature' };
    return { ok: false, pending: true };
  });
  await recovery.tick();
  assert.deepEqual(completions.map(c => [c.id, c.status]), [
    ['paid','confirmed'], ['failed','failed'], ['unknown','pending'], ['rpc-error','pending'], ['fallback','confirmed'],
  ]);
  assert.equal(completions[0].signature, 'verified-signature');
  assert.equal(completions[4].signature, 'recovered-signature');
});

test('PostgreSQL stores attempts durably, leases work and enforces quote ownership',
  { skip: !recoveryDatabase }, async () => {
    process.env.DATABASE_URL = recoveryDatabase;
    process.env.BATTLECITY_STORAGE_MODE = 'postgres';
    const db = require('../src/database');
    const id = `ply-${crypto.randomUUID()}`;
    const other = `ply-${crypto.randomUUID()}`;
    const quoteId = crypto.randomUUID();
    const item = { quoteId, playerId: id, walletAddress: 'wallet', itemId: 'fuel-1', currency: 'sol',
      amountAtomic: '10000000', decimals: 9, network: 'devnet', quoteToken: 'fixture-token',
      issuedAt: Date.now() - 1000, expiresAt: Date.now() + 60000 };
    try {
      await db.getPool().query(`INSERT INTO battlecity_players
        (id,provider,display_name,created_at,updated_at,last_seen_at)
        VALUES ($1,'guest',$2,NOW(),NOW(),NOW()),($3,'guest',$4,NOW(),NOW(),NOW())`, [id,'Test',other,'Other']);
      assert.equal((await attempts.register(item)).status, 'pending');
      await attempts.register(item);
      await assert.rejects(attempts.register({ ...item, playerId: other }), /does not match/);
      assert.equal((await attempts.claim(1, 'mainnet-beta')).length, 0, 'a different network cannot claim the attempt');
      const [first, second] = await Promise.all([attempts.claim(1, 'devnet'), attempts.claim(1, 'devnet')]);
      assert.equal(first.length + second.length, 1, 'two workers cannot claim one attempt');
      const leased = first[0] || second[0];
      assert.equal(await attempts.complete({ ...leased, claim_id: 'wrong-lease' }, 'confirmed'), false);
      assert.equal(await attempts.complete(leased, 'pending'), true);
      assert.equal((await attempts.claim(1, 'devnet')).length, 0, 'uncertain attempts back off');
      const page = await attempts.listPending({ limit: 50 });
      const shown = page.items.find(r => r.quoteId === quoteId);
      assert.equal(shown.amountAtomic, '10000000');
      assert.equal(Object.hasOwn(shown, 'quoteToken'), false, 'admin output does not expose quote tokens');
      await db.getPool().query('UPDATE battlecity_shop_purchase_attempts SET next_check_at = NOW() WHERE quote_id = $1', [quoteId]);
      const retry = (await attempts.claim(1, 'devnet'))[0];
      assert.equal(await attempts.complete(retry, 'confirmed', 'verified-signature'), true);
      assert.equal((await attempts.register(item)).status, 'confirmed', 'reimport cannot reopen a resolved attempt');
      assert.equal((await attempts.listPending({ limit: 50 })).items.some(r => r.quoteId === quoteId), false);
    } finally {
      await db.getPool().query('DELETE FROM battlecity_players WHERE id IN ($1,$2)', [id,other]);
      await db.closePool();
    }
  });

test('worker recovers a payment after the client disappears and grants the item once',
  { skip: !recoveryDatabase }, async (t) => {
    process.env.DATABASE_URL = recoveryDatabase;
    process.env.BATTLECITY_STORAGE_MODE = 'postgres';
    const previousSecret = process.env.BATTLECITY_SHOP_QUOTE_SECRET;
    process.env.BATTLECITY_SHOP_QUOTE_SECRET = 'test-recovery-secret-32-characters-minimum';
    const db = require('../src/database');
    const { Keypair } = require('@solana/web3.js');
    const walletAddress = Keypair.generate().publicKey.toBase58();
    const player = await players.findOrCreateWalletPlayer(walletAddress);
    const quote = { v: 2, id: crypto.randomUUID(), playerId: player.id, walletAddress,
      itemId: 'fuel-one', currency: 'sol', amountAtomic: '10000000', treasury: shop.TREASURY,
      tokenMint: shop.TOKEN_MINT, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      tokenDecimals: 6, network: shop.NETWORK, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 60000 };
    const encoded = Buffer.from(JSON.stringify(quote)).toString('base64url');
    const token = `${encoded}.${crypto.createHmac('sha256', process.env.BATTLECITY_SHOP_QUOTE_SECRET).update(encoded).digest('base64url')}`;
    const signature = '2'.repeat(88);
    const chain = { blockTime: Math.floor(Date.now()/1000), meta: { err: null }, transaction: { message: {
      accountKeys: [{ pubkey: walletAddress, signer: true }], instructions: [
        { program: 'system', parsed: { type: 'transfer', info: { source: walletAddress, destination: shop.TREASURY, lamports: 10000000 } } },
        { program: 'spl-memo', parsed: `BATC-SHOP-V1:${quote.id}` },
      ],
    } } };
    t.mock.method(rpc, 'getTransaction', async () => chain);
    try {
      const before = await economy.ensureAccountForPlayer(player);
      await recovery.track(player, { quoteToken: token, signature });
      // No game client is involved from this point on.
      await recovery.tick();
      assert.equal((await economy.readAccount(player.id)).fuelBalance, before.fuelBalance + 1);
      assert.equal((await shop.recoverPurchase(player, { quoteToken: token, signature })).ok, true);
      assert.equal((await economy.readAccount(player.id)).fuelBalance, before.fuelBalance + 1);
      const stored = await db.getPool().query('SELECT status FROM battlecity_shop_purchase_attempts WHERE quote_id = $1', [quote.id]);
      assert.equal(stored.rows[0].status, 'confirmed');
      // A confirmed payment from an older release may not have an attempt row.
      await db.getPool().query('DELETE FROM battlecity_shop_purchase_attempts WHERE quote_id = $1', [quote.id]);
      assert.equal((await recovery.track(player, { quoteToken: token })).status, 'confirmed');
      assert.equal((await db.getPool().query('SELECT 1 FROM battlecity_shop_purchase_attempts WHERE quote_id = $1', [quote.id])).rowCount, 0);
    } finally {
      await db.getPool().query('DELETE FROM battlecity_players WHERE id = $1', [player.id]);
      await db.closePool();
      if (previousSecret === undefined) delete process.env.BATTLECITY_SHOP_QUOTE_SECRET;
      else process.env.BATTLECITY_SHOP_QUOTE_SECRET = previousSecret;
    }
  });

test('worker finds a submitted payment by quote memo when the wallet returns no signature',
  { skip: !recoveryDatabase }, async (t) => {
    process.env.DATABASE_URL = recoveryDatabase;
    process.env.BATTLECITY_STORAGE_MODE = 'postgres';
    const previousSecret = process.env.BATTLECITY_SHOP_QUOTE_SECRET;
    process.env.BATTLECITY_SHOP_QUOTE_SECRET = 'test-recovery-secret-32-characters-minimum';
    const db = require('../src/database');
    const { Keypair, Connection } = require('@solana/web3.js');
    const walletAddress = Keypair.generate().publicKey.toBase58();
    const player = await players.findOrCreateWalletPlayer(walletAddress);
    const quote = { v: 2, id: crypto.randomUUID(), playerId: player.id, walletAddress,
      itemId: 'fuel-one', currency: 'sol', amountAtomic: '10000000', treasury: shop.TREASURY,
      tokenMint: shop.TOKEN_MINT, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      tokenDecimals: 6, network: shop.NETWORK, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 60000 };
    const encoded = Buffer.from(JSON.stringify(quote)).toString('base64url');
    const token = `${encoded}.${crypto.createHmac('sha256', process.env.BATTLECITY_SHOP_QUOTE_SECRET).update(encoded).digest('base64url')}`;
    const signature = '3'.repeat(88), memo = `BATC-SHOP-V1:${quote.id}`;
    const chain = { blockTime: Math.floor(Date.now()/1000), meta: { err: null }, transaction: { message: {
      accountKeys: [{ pubkey: walletAddress, signer: true }], instructions: [
        { program: 'system', parsed: { type: 'transfer', info: { source: walletAddress, destination: shop.TREASURY, lamports: 10000000 } } },
        { program: 'spl-memo', parsed: memo },
      ],
    } } };
    t.mock.method(Connection.prototype, 'getSignaturesForAddress', async () => [{ signature, memo, err: null, blockTime: chain.blockTime }]);
    t.mock.method(rpc, 'getTransaction', async () => chain);
    try {
      const before = await economy.ensureAccountForPlayer(player);
      await recovery.track(player, { quoteToken: token });
      await recovery.tick();
      assert.equal((await economy.readAccount(player.id)).fuelBalance, before.fuelBalance + 1);
      const stored = await db.getPool().query('SELECT status,signature FROM battlecity_shop_purchase_attempts WHERE quote_id = $1', [quote.id]);
      assert.deepEqual(stored.rows[0], { status: 'confirmed', signature });
      assert.equal((await shop.recoverPurchase(player, { quoteToken: token })).ok, true);
      assert.equal((await economy.readAccount(player.id)).fuelBalance, before.fuelBalance + 1);
    } finally {
      await db.getPool().query('DELETE FROM battlecity_players WHERE id = $1', [player.id]);
      await db.closePool();
      if (previousSecret === undefined) delete process.env.BATTLECITY_SHOP_QUOTE_SECRET;
      else process.env.BATTLECITY_SHOP_QUOTE_SECRET = previousSecret;
    }
  });
