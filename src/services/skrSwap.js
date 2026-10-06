const crypto = require('crypto');
const { VersionedTransaction, PublicKey } = require('@solana/web3.js');
const skr = require('./skrToken');
const BASE = 'https://api.jup.ag/swap/v2';
const SOL = 'So11111111111111111111111111111111111111112';

function config() {
  const key = String(process.env.JUPITER_API_KEY || '');
  const secret = String(process.env.BATTLECITY_SWAP_QUOTE_SECRET || '');
  if (!key || secret.length < 32) throw new Error('Swap provider is not configured.');
  return { key, secret };
}
async function provider(path, body = null) {
  const response = await fetch(`${BASE}${path}`, { method: body ? 'POST' : 'GET',
    headers: { 'x-api-key': config().key, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(15000), ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error('Swap provider is temporarily unavailable.');
  return response.json();
}
function requireWallet(player) {
  if (player?.provider !== 'wallet' || !player.walletAddress) throw new Error('Wallet login required.');
  return new PublicKey(player.walletAddress);
}
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', config().secret).update(body).digest('base64url')}`;
}
function read(token) {
  if (typeof token !== 'string' || token.length > 8192) throw new Error('Invalid swap quote.');
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('Invalid swap quote.');
  const expected = crypto.createHmac('sha256', config().secret).update(parts[0]).digest();
  const actual = Buffer.from(parts[1], 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(expected, actual)) throw new Error('Invalid swap quote.');
  return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
}
function decode(value) {
  if (typeof value !== 'string' || value.length > 2000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Invalid swap transaction.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > 1232) throw new Error('Swap transaction is too large.');
  return VersionedTransaction.deserialize(bytes);
}
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
async function quote(player, input) {
  const wallet = requireWallet(player), token = skr.requireConfig();
  if (!['sol', 'skr'].includes(input?.from)) throw new Error('Swap direction must be sol or skr.');
  const amount = skr.atomic(input.amount, input.from === 'sol' ? 9 : token.decimals).toString();
  const slippageBps = input.slippageBps ?? 50;
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 500) throw new Error('Slippage must be 1–500 basis points.');
  const inputMint = input.from === 'sol' ? SOL : token.mint;
  const outputMint = input.from === 'sol' ? token.mint : SOL;
  const order = await provider(`/order?${new URLSearchParams({ inputMint, outputMint, amount,
    taker: wallet.toBase58(), slippageBps: String(slippageBps) })}`);
  if (!order.transaction || typeof order.requestId !== 'string' || order.requestId.length > 256
    || order.inputMint !== inputMint || order.outputMint !== outputMint || order.inAmount !== amount
    || !/^\d+$/.test(order.outAmount || '') || BigInt(order.outAmount) <= 0n) throw new Error('No executable SOL/SKR quote is available.');
  const transaction = decode(order.transaction);
  const signers = transaction.message.staticAccountKeys.slice(0, transaction.message.header.numRequiredSignatures);
  if (!signers.some((k) => k.equals(wallet))) throw new Error('Swap provider returned the wrong wallet.');
  const expireAt = order.expireAt ? Date.parse(order.expireAt) : Date.now() + 120000;
  const expiresAt = Math.min(Date.now() + 120000, Number.isFinite(expireAt) ? expireAt : Date.now() + 120000);
  if (expiresAt <= Date.now()) throw new Error('Swap quote expired. Please retry.');
  const quoteToken = sign({ purpose: 'skr-swap-v1', playerId: player.id, wallet: wallet.toBase58(),
    requestId: order.requestId, messageHash: hash(transaction.message.serialize()), expiresAt });
  return { quoteToken, transaction: order.transaction, inputMint, outputMint, inAmount: amount,
    outAmount: order.outAmount, slippageBps: order.slippageBps ?? slippageBps,
    feeBps: order.feeBps, feeMint: order.feeMint, platformFee: order.platformFee || null,
    lastValidBlockHeight: order.lastValidBlockHeight || null, expiresAt: new Date(expiresAt).toISOString() };
}
async function execute(player, input) {
  const wallet = requireWallet(player), signedQuote = read(input?.quoteToken);
  if (signedQuote.purpose !== 'skr-swap-v1' || signedQuote.playerId !== player.id
    || signedQuote.wallet !== wallet.toBase58() || signedQuote.expiresAt <= Date.now()) throw new Error('Swap quote expired or belongs to another wallet.');
  const tx = decode(input.signedTransaction), message = Buffer.from(tx.message.serialize());
  if (hash(message) !== signedQuote.messageHash) throw new Error('Signed swap differs from the quoted transaction.');
  const index = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).findIndex((k) => k.equals(wallet));
  const publicKey = crypto.createPublicKey({ format: 'der', type: 'spki',
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), wallet.toBuffer()]) });
  if (index < 0 || !crypto.verify(null, message, publicKey, tx.signatures[index])) throw new Error('Wallet signature is invalid.');
  const result = await provider('/execute', { requestId: signedQuote.requestId, signedTransaction: input.signedTransaction });
  if (result.status === 'Success' && result.code === 0) {
    await require('../stores/swapExecutionStore').record(player.id, result.signature, signedQuote.requestId);
  }
  return { ok: result.status === 'Success' && result.code === 0, status: result.status,
    signature: result.signature || null, code: result.code,
    totalInputAmount: result.totalInputAmount || null, totalOutputAmount: result.totalOutputAmount || null };
}
module.exports = { quote, execute };
