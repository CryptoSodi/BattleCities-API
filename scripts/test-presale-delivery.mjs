import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

const apiBase = String(process.env.BATTLECITY_PRESALE_TEST_API || 'https://api.battlecities.com').replace(/\/$/, '');
const buyerKeypairPath = process.env.BATTLECITY_PRESALE_TEST_BUYER_KEYPAIR;
const payAmount = process.env.BATTLECITY_PRESALE_TEST_PAY_SOL || '0.001';
assert.ok(buyerKeypairPath, 'Set BATTLECITY_PRESALE_TEST_BUYER_KEYPAIR to a funded devnet keypair path.');

const buyer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await fs.readFile(buyerKeypairPath, 'utf8'))));
const state = await request('/api/presale/state');
assert.equal(state.network, 'devnet');
assert.equal(state.configured, true);
const connection = new Connection(state.rpcUrl, 'confirmed');
const treasury = new PublicKey(state.treasury);
const mint = new PublicKey(state.token.mint);
const buyerTokenAccount = getAssociatedTokenAddressSync(
  mint,
  buyer.publicKey,
  false,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
);
const treasuryBefore = await connection.getBalance(treasury, 'confirmed');
const tokensBefore = await tokenBalance(connection, buyerTokenAccount);

const quote = await request('/api/presale/quote', {
  method: 'POST',
  body: JSON.stringify({ wallet: buyer.publicKey.toBase58(), method: 'SOL', payAmount }),
});
const transaction = Transaction.from(Buffer.from(quote.transaction, 'base64'));
transaction.partialSign(buyer);
const paymentSignature = await connection.sendRawTransaction(transaction.serialize(), { maxRetries: 3 });
const paymentConfirmation = await connection.confirmTransaction({
  signature: paymentSignature,
  blockhash: quote.blockhash,
  lastValidBlockHeight: quote.lastValidBlockHeight,
}, 'confirmed');
assert.equal(paymentConfirmation.value.err, null);

const first = await request('/api/presale/verify', {
  method: 'POST',
  body: JSON.stringify({ signature: paymentSignature, quoteToken: quote.quoteToken }),
});
assert.equal(first.purchase.deliveryStatus, 'delivered');
assert.ok(first.purchase.deliveryTransactionSignature);
const tokensAfterDelivery = await tokenBalance(connection, buyerTokenAccount);
const treasuryAfter = await connection.getBalance(treasury, 'confirmed');
assert.equal(tokensAfterDelivery - tokensBefore, BigInt(first.purchase.tokenMicros));
assert.ok(treasuryAfter - treasuryBefore >= BigInt(first.purchase.paymentAtomic));

const retry = await request('/api/presale/verify', {
  method: 'POST',
  body: JSON.stringify({ signature: paymentSignature, quoteToken: quote.quoteToken }),
});
assert.equal(retry.purchase.deliveryStatus, 'delivered');
assert.equal(retry.purchase.deliveryTransactionSignature, first.purchase.deliveryTransactionSignature);
assert.equal(await tokenBalance(connection, buyerTokenAccount), tokensAfterDelivery);

console.log(JSON.stringify({
  buyer: buyer.publicKey.toBase58(),
  paymentSignature,
  deliverySignature: first.purchase.deliveryTransactionSignature,
  tokenMicrosDelivered: first.purchase.tokenMicros,
  deliveryAttempts: retry.purchase.deliveryAttempts,
  duplicateDeliveryPrevented: true,
}, null, 2));

async function tokenBalance(connection, address) {
  try {
    return (await getAccount(connection, address, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount;
  } catch (error) {
    if (error?.name === 'TokenAccountNotFoundError') return 0n;
    throw error;
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `API returned ${response.status}`);
  return body;
}
