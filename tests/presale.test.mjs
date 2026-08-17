import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const presale = require('../src/services/presaleService.js');
const presaleStore = require('../src/stores/presaleStore.js');

test('presale decimal amounts retain their exact atomic value', () => {
  assert.equal(presale.parseDecimalToAtomic('0.0075', 6), 7500n);
  assert.equal(presale.parseDecimalToAtomic('1.25', 9), 1250000000n);
  assert.equal(presale.decimalString(7500n, 6), '0.0075');
  assert.equal(presale.decimalString(200000000000n, 6), '200000');
  assert.throws(() => presale.parseDecimalToAtomic('0.0000001', 6));
});

test('presale quote signatures are tamper evident', () => {
  const secret = crypto.randomBytes(32).toString('hex');
  const payload = {
    walletAddress: 'ExampleWallet1111111111111111111111111111111111',
    paymentAtomic: '1000000000',
    expiresAt: '2026-09-13T00:00:00.000Z',
  };
  const token = presale.signPayload(payload, secret);

  assert.deepEqual(presale.verifyQuoteToken(token, secret), payload);
  assert.throws(() => presale.verifyQuoteToken(`${token}x`, secret));
});

test('Pyth SOL/USD values convert exactly to USD micros', () => {
  assert.equal(presale.pythPriceToUsdMicros('15012345678', -8), 150123456n);
  assert.equal(presale.pythPriceToUsdMicros('150', 0), 150000000n);
  assert.throws(() => presale.pythPriceToUsdMicros('0', -8));
});

test('presale payment verification requires both the exact transfer and quote memo', () => {
  const wallet = '7YttLkHDoqhp4wjjWBt61j8oLxZKRH2KpWg8nUYSsLZi';
  const treasury = '6wQz66BgRsX6DVHAD3PDCXjKVpe3LLrj3FGiQwCSZV7F';
  const quoteToken = 'signed-quote';
  const quote = {
    walletAddress: wallet,
    paymentAtomic: '10000000',
    issuedAt: 1789257500000,
    expiresAt: 1789257620000,
  };
  const transaction = {
    blockTime: 1789257560,
    meta: { err: null },
    transaction: { message: {
      accountKeys: [{ pubkey: wallet, signer: true }],
      instructions: [
        {
          program: 'system',
          parsed: { type: 'transfer', info: {
            source: wallet,
            destination: treasury,
            lamports: 10000000,
          } },
        },
        {
          program: 'spl-memo',
          programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
          parsed: `BATC-PRESALE-V1:${quoteToken}`,
        },
      ],
    } },
  };
  const config = { treasury: { toBase58: () => treasury }, endAt: new Date(1789257700000) };

  assert.doesNotThrow(() => presale.verifyPayment(transaction, quote, config, quoteToken));
  transaction.transaction.message.instructions[1].parsed = 'BATC-PRESALE-V1:another-quote';
  assert.throws(
    () => presale.verifyPayment(transaction, quote, config, quoteToken),
    /missing its presale quote memo/,
  );
});

test('local presale store reserves stage capacity and consumes each quote once', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'battlecity-presale-'));
  const previousFile = process.env.BATTLECITY_PRESALE_FILE;
  const previousMode = process.env.BATTLECITY_STORAGE_MODE;
  process.env.BATTLECITY_PRESALE_FILE = path.join(directory, 'presale.json');
  process.env.BATTLECITY_STORAGE_MODE = 'local';
  const quote = {
    quoteId: crypto.randomUUID(),
    walletAddress: 'wallet',
    paymentAtomic: '10',
    usdMicros: '20',
    tokenMicros: '60',
    stageId: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  try {
    await presaleStore.reserveQuote(quote, '100');
    await assert.rejects(
      presaleStore.reserveQuote({ ...quote, quoteId: crypto.randomUUID(), tokenMicros: '50' }, '100'),
      /no longer has enough BATC/,
    );
    const allocation = {
      signature: 'signature-one',
      ...quote,
      paymentMethod: 'SOL',
      confirmedAt: new Date().toISOString(),
    };
    const first = await presaleStore.consumeQuoteAndRecordAllocation(allocation, '100');
    assert.equal(first.inserted, true);
    const retry = await presaleStore.consumeQuoteAndRecordAllocation(allocation, '100');
    assert.equal(retry.inserted, false);

    const prepared = await presaleStore.prepareDelivery('signature-one', {
      signature: 'delivery-one',
      rawTransaction: 'signed-transaction',
      blockhash: 'blockhash-one',
      lastValidBlockHeight: 123,
    });
    assert.equal(prepared.deliveryStatus, 'sending');
    assert.equal(prepared.deliveryAttempts, 1);
    const duplicatePrepare = await presaleStore.prepareDelivery('signature-one', {
      signature: 'delivery-two',
      rawTransaction: 'another-transaction',
      blockhash: 'blockhash-two',
      lastValidBlockHeight: 456,
    });
    assert.equal(duplicatePrepare.deliveryTransactionSignature, 'delivery-one');
    assert.equal(duplicatePrepare.deliveryAttempts, 1);
    const delivered = await presaleStore.markDeliveryDelivered('signature-one', 'delivery-one');
    assert.equal(delivered.deliveryStatus, 'delivered');
    const afterDeliveryRetry = await presaleStore.prepareDelivery('signature-one', {
      signature: 'delivery-three',
      rawTransaction: 'third-transaction',
      blockhash: 'blockhash-three',
      lastValidBlockHeight: 789,
    });
    assert.equal(afterDeliveryRetry.deliveryTransactionSignature, 'delivery-one');
    assert.equal(afterDeliveryRetry.deliveryAttempts, 1);
    await assert.rejects(
      presaleStore.consumeQuoteAndRecordAllocation(
        { ...allocation, signature: 'signature-two' },
        '100',
      ),
      /already been used/,
    );
  } finally {
    if (previousFile === undefined) delete process.env.BATTLECITY_PRESALE_FILE;
    else process.env.BATTLECITY_PRESALE_FILE = previousFile;
    if (previousMode === undefined) delete process.env.BATTLECITY_STORAGE_MODE;
    else process.env.BATTLECITY_STORAGE_MODE = previousMode;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
