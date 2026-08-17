const crypto = require('crypto');
const {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} = require('@solana/web3.js');
const presaleStore = require('../stores/presaleStore');
const solanaRpc = require('./solanaRpc');

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const MEMO_PREFIX = 'BATC-PRESALE-V1:';
const TOKEN_MINT = 'feptDFpEGgFvxDwveWD6opDUCet5ve3f3WHPTBvBLvh';
const TOKEN_STANDARD = 'Token-2022';
const TOKEN_DECIMALS = 6;
const TOKEN_TOTAL_SUPPLY_MICROS = 50_000_000_000_000n;
const TOKEN_SCALE = 1_000_000n;
const QUOTE_TTL_MS = 2 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 1000;
const PYTH_SOL_USD_FEED_ID = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
const DEFAULT_PYTH_HERMES_URL = 'https://pyth.dourolabs.app/hermes';
const STAGES = Object.freeze([
  { id: 1, label: 'Stage 1', priceLamports: 40_000n, allocationMicros: 200_000_000_000n },
  { id: 2, label: 'Stage 2', priceLamports: 66_667n, allocationMicros: 150_000_000_000n },
  { id: 3, label: 'Stage 3', priceLamports: 80_000n, allocationMicros: 150_000_000_000n },
]);

function getConfig() {
  const endAt = new Date(process.env.BATTLECITY_PRESALE_END_AT || '2026-09-13T00:00:00.000Z');
  const treasuryAddress = String(process.env.BATTLECITY_PRESALE_TREASURY_ADDRESS || '').trim();
  let treasury = null;
  const tokenMintAddress = String(process.env.BATTLECITY_PRESALE_TOKEN_MINT || '').trim();
  let tokenMint = null;
  try {
    treasury = treasuryAddress ? new PublicKey(treasuryAddress) : null;
  } catch {
    treasury = null;
  }
  try {
    tokenMint = tokenMintAddress ? new PublicKey(tokenMintAddress) : null;
  } catch {
    tokenMint = null;
  }
  return {
    endAt,
    network: String(process.env.BATTLECITY_PRESALE_NETWORK || 'devnet').toLowerCase(),
    quoteSecret: String(process.env.BATTLECITY_PRESALE_QUOTE_SECRET || ''),
    rpcUrl: process.env.BATTLECITY_PRESALE_SOLANA_RPC_URL || solanaRpc.getRpcUrl(),
    pythApiKey: String(process.env.BATTLECITY_PRESALE_PYTH_API_KEY || ''),
    pythFeedId: String(process.env.BATTLECITY_PRESALE_PYTH_SOL_USD_FEED_ID || PYTH_SOL_USD_FEED_ID),
    pythHermesUrl: String(process.env.BATTLECITY_PRESALE_PYTH_HERMES_URL || DEFAULT_PYTH_HERMES_URL).replace(/\/$/, ''),
    maxOracleAgeSeconds: Number(process.env.BATTLECITY_PRESALE_MAX_ORACLE_AGE_SECONDS || 90),
    maxOracleConfidenceBps: Number(process.env.BATTLECITY_PRESALE_MAX_ORACLE_CONFIDENCE_BPS || 100),
    treasury,
    tokenMint,
  };
}

function isConfigured(config = getConfig()) {
  return config.network === 'devnet'
    && config.treasury !== null
    && config.tokenMint?.toBase58() === TOKEN_MINT
    && config.quoteSecret.length >= 32
    && Number.isFinite(config.endAt.getTime());
}

function parseDecimalToAtomic(value, decimals) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error('Enter a valid positive payment amount.');
  }
  const [whole, fraction = ''] = normalized.split('.');
  if (fraction.length > decimals) throw new Error(`Use no more than ${decimals} decimal places.`);
  const atomic = BigInt(whole) * 10n ** BigInt(decimals)
    + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals));
  if (atomic <= 0n) throw new Error('Payment amount must be greater than zero.');
  return atomic;
}

function decimalString(value, decimals) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const divisor = 10n ** BigInt(decimals);
  const whole = absolute / divisor;
  const fraction = (absolute % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function signPayload(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyQuoteToken(token, secret) {
  const [encoded, suppliedSignature] = String(token || '').split('.');
  if (!encoded || !suppliedSignature) throw new Error('Invalid quote token.');
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest();
  const supplied = Buffer.from(suppliedSignature, 'base64url');
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    throw new Error('Quote signature is invalid.');
  }
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

function pythPriceToUsdMicros(price, exponent) {
  const value = BigInt(price);
  const expo = Number(exponent);
  if (value <= 0n || !Number.isInteger(expo)) throw new Error('Oracle returned an invalid SOL/USD price.');
  if (expo >= -6) return value * (10n ** BigInt(expo + 6));
  return value / (10n ** BigInt(-6 - expo));
}

async function getLiveSolUsdPrice(config) {
  if (typeof fetch !== 'function') throw new Error('Live pricing is unavailable in this runtime.');
  const endpoint = `${config.pythHermesUrl}/v2/updates/price/latest?ids[]=${encodeURIComponent(config.pythFeedId)}`;
  const headers = { accept: 'application/json' };
  if (config.pythApiKey) headers.authorization = `Bearer ${config.pythApiKey}`;
  let response;
  try {
    response = await fetch(endpoint, { headers });
  } catch {
    throw new Error('Unable to retrieve the live SOL/USD price.');
  }
  if (!response.ok) throw new Error('Live SOL/USD pricing is temporarily unavailable.');
  const body = await response.json();
  const update = body?.parsed?.[0];
  if (normalizeFeedId(update?.id) !== normalizeFeedId(config.pythFeedId)) {
    throw new Error('Oracle returned the wrong price feed.');
  }
  const price = update?.price;
  const publishTime = Number(price?.publish_time);
  const usdMicrosPerSol = pythPriceToUsdMicros(price?.price, price?.expo);
  const confidenceMicros = String(price?.conf) === '0'
    ? 0n
    : pythPriceToUsdMicros(price?.conf, price?.expo);
  const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - publishTime);
  if (!Number.isFinite(publishTime) || ageSeconds > config.maxOracleAgeSeconds) {
    throw new Error('Live SOL/USD price is stale. Please try again shortly.');
  }
  if (confidenceMicros * 10_000n > usdMicrosPerSol * BigInt(config.maxOracleConfidenceBps)) {
    throw new Error('Live SOL/USD price confidence is too low. Please try again shortly.');
  }
  return {
    usdMicrosPerSol,
    publishedAt: new Date(publishTime * 1000).toISOString(),
    source: 'Pyth SOL/USD',
  };
}

function normalizeFeedId(value) {
  return String(value || '').toLowerCase().replace(/^0x/, '');
}

function aggregate(records) {
  const totals = new Map(STAGES.map((stage) => [stage.id, {
    soldMicros: 0n,
    raisedMicros: 0n,
    raisedLamports: 0n,
  }]));
  records.forEach((record) => {
    const total = totals.get(record.stageId);
    if (!total) return;
    total.soldMicros += BigInt(record.tokenMicros);
    total.raisedMicros += BigInt(record.usdMicros);
    total.raisedLamports += BigInt(record.paymentAtomic);
  });
  return totals;
}

function currentStage(totals) {
  return STAGES.find((stage) => totals.get(stage.id).soldMicros < stage.allocationMicros) || null;
}

async function getState() {
  const config = getConfig();
  const records = await presaleStore.listAllocations();
  const totals = aggregate(records);
  const stage = currentStage(totals);
  const raisedMicros = Array.from(totals.values()).reduce((sum, total) => sum + total.raisedMicros, 0n);
  const raisedLamports = Array.from(totals.values()).reduce((sum, total) => sum + total.raisedLamports, 0n);
  const soldMicros = Array.from(totals.values()).reduce((sum, total) => sum + total.soldMicros, 0n);
  const targetLamports = STAGES.reduce(
    (sum, item) => sum + (item.priceLamports * item.allocationMicros) / TOKEN_SCALE,
    0n,
  );

  return {
    configured: isConfigured(config),
    network: config.network,
    rpcUrl: config.rpcUrl,
    treasury: config.treasury?.toBase58() || null,
    token: {
      name: 'BattleCity',
      symbol: 'BATC',
      mint: config.tokenMint?.toBase58() || null,
      standard: TOKEN_STANDARD,
      decimals: TOKEN_DECIMALS,
      totalSupplyBatc: decimalString(TOKEN_TOTAL_SUPPLY_MICROS, TOKEN_DECIMALS),
    },
    endAt: config.endAt.toISOString(),
    ended: Date.now() >= config.endAt.getTime() || stage === null,
    raisedSol: decimalString(raisedLamports, 9),
    targetSol: decimalString(targetLamports, 9),
    soldBatc: decimalString(soldMicros, 6),
    participants: new Set(records.map((record) => record.walletAddress)).size,
    currentStageId: stage?.id || null,
    currentPriceSol: stage ? decimalString(stage.priceLamports, 9) : null,
    paymentMethods: { SOL: true, USDC: false },
    stages: STAGES.map((item) => {
      const total = totals.get(item.id);
      const sold = total.soldMicros > item.allocationMicros ? item.allocationMicros : total.soldMicros;
      return {
        id: item.id,
        label: item.label,
        priceSol: decimalString(item.priceLamports, 9),
        allocationBatc: decimalString(item.allocationMicros, 6),
        soldBatc: decimalString(sold, 6),
        raisedSol: decimalString(total.raisedLamports, 9),
        status: sold >= item.allocationMicros ? 'sold-out' : item.id === stage?.id ? 'active' : 'upcoming',
      };
    }),
    updatedAt: new Date().toISOString(),
  };
}

async function createQuote(input) {
  const config = getConfig();
  if (!isConfigured(config)) throw new Error('Presale backend is not configured yet.');
  if (Date.now() >= config.endAt.getTime()) throw new Error('The presale has ended.');
  if (String(input?.method || '').toUpperCase() !== 'SOL') throw new Error('Only SOL payments are accepted.');

  let wallet;
  try {
    wallet = new PublicKey(String(input?.wallet || ''));
  } catch {
    throw new Error('Invalid wallet address.');
  }

  const records = await presaleStore.listAllocations();
  const totals = aggregate(records);
  const stage = currentStage(totals);
  if (stage === null) throw new Error('All presale stages are sold out.');

  const paymentAtomic = parseDecimalToAtomic(input?.payAmount, 9);
  if (paymentAtomic > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Payment amount is too large.');
  const usdMicros = 0n;
  const tokenMicros = paymentAtomic * TOKEN_SCALE / stage.priceLamports;
  if (tokenMicros <= 0n) throw new Error('Payment is too small for the current stage.');

  const remaining = stage.allocationMicros - totals.get(stage.id).soldMicros;
  if (tokenMicros > remaining) throw new Error(`Only ${decimalString(remaining, 6)} BATC remain in ${stage.label}.`);

  const issuedAt = Date.now();
  const payload = {
    v: 1,
    id: crypto.randomUUID(),
    walletAddress: wallet.toBase58(),
    paymentAtomic: paymentAtomic.toString(),
    usdMicros: usdMicros.toString(),
    tokenMicros: tokenMicros.toString(),
    stageId: stage.id,
    treasury: config.treasury.toBase58(),
    network: config.network,
    tokenMint: config.tokenMint.toBase58(),
    issuedAt,
    expiresAt: issuedAt + QUOTE_TTL_MS,
  };
  const quoteToken = signPayload(payload, config.quoteSecret);
  const connection = new Connection(config.rpcUrl, 'confirmed');
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({ feePayer: wallet, recentBlockhash: blockhash });
  transaction.add(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: config.treasury, lamports: Number(paymentAtomic) }));
  transaction.add(new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(`${MEMO_PREFIX}${quoteToken}`, 'utf8') }));
  await presaleStore.reserveQuote({
    quoteId: payload.id,
    walletAddress: payload.walletAddress,
    paymentAtomic: payload.paymentAtomic,
    usdMicros: payload.usdMicros,
    tokenMicros: payload.tokenMicros,
    stageId: payload.stageId,
    expiresAt: new Date(payload.expiresAt).toISOString(),
  }, stage.allocationMicros.toString());

  return {
    quoteToken,
    transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    blockhash,
    lastValidBlockHeight,
    expiresAt: new Date(payload.expiresAt).toISOString(),
    stageId: stage.id,
    stageLabel: stage.label,
    method: 'SOL',
    payAmount: decimalString(paymentAtomic, 9),
    batcAmount: decimalString(tokenMicros, 6),
    tokenPriceSol: decimalString(stage.priceLamports, 9),
    treasury: config.treasury.toBase58(),
    network: config.network,
  };
}

async function verifyPurchase(input) {
  const config = getConfig();
  if (!isConfigured(config)) throw new Error('Presale backend is not configured yet.');
  const signature = String(input?.signature || '');
  if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) throw new Error('Invalid transaction signature.');

  const existing = await presaleStore.findBySignature(signature);
  if (existing !== null) return { purchase: existing, state: await getState() };

  const quote = verifyQuoteToken(input?.quoteToken, config.quoteSecret);
  validateQuote(quote, config);
  const tx = await solanaRpc.getTransaction(signature, config.rpcUrl);
  if (tx === null) throw new Error('Transaction is not confirmed on Solana devnet yet.');
  verifyPayment(tx, quote, config, input.quoteToken);

  const stage = STAGES.find((item) => item.id === quote.stageId);
  const result = await presaleStore.consumeQuoteAndRecordAllocation({
    signature,
    quoteId: quote.id,
    walletAddress: quote.walletAddress,
    paymentMethod: 'SOL',
    paymentAtomic: quote.paymentAtomic,
    usdMicros: quote.usdMicros,
    tokenMicros: quote.tokenMicros,
    stageId: quote.stageId,
    confirmedAt: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : new Date().toISOString(),
  }, stage.allocationMicros.toString());
  return { purchase: result.record, state: await getState() };
}

function validateQuote(quote, config) {
  const stage = STAGES.find((item) => item.id === quote.stageId);
  if (!stage
    || quote.v !== 1
    || quote.network !== config.network
    || quote.treasury !== config.treasury.toBase58()
    || quote.tokenMint !== config.tokenMint.toBase58()
    || !Number.isFinite(quote.issuedAt)
    || !Number.isFinite(quote.expiresAt)
    || quote.expiresAt <= quote.issuedAt
    || quote.expiresAt - quote.issuedAt > QUOTE_TTL_MS
    || !/^[0-9a-f-]{36}$/i.test(String(quote.id || ''))
    || !/^\d+$/.test(String(quote.paymentAtomic || ''))
    || !/^\d+$/.test(String(quote.usdMicros || ''))
    || !/^\d+$/.test(String(quote.tokenMicros || ''))) {
    throw new Error('Quote does not match the active presale.');
  }
  try {
    if (new PublicKey(quote.walletAddress).toBase58() !== quote.walletAddress) throw new Error();
  } catch {
    throw new Error('Quote contains an invalid wallet address.');
  }
}

function verifyPayment(tx, quote, config, quoteToken) {
  if (tx.meta?.err !== null && tx.meta?.err !== undefined) throw new Error('Transaction failed on chain.');
  if (!Number.isFinite(tx.blockTime)) throw new Error('Transaction confirmation time is unavailable.');
  const confirmedAt = tx.blockTime * 1000;
  if (confirmedAt < quote.issuedAt - MAX_CLOCK_SKEW_MS
    || confirmedAt > quote.expiresAt + MAX_CLOCK_SKEW_MS
    || confirmedAt > config.endAt.getTime() + MAX_CLOCK_SKEW_MS) {
    throw new Error('The payment was confirmed outside the quote validity window.');
  }

  const accountKeys = tx.transaction?.message?.accountKeys || [];
  const signed = accountKeys.some((key) => key?.signer === true && key?.pubkey === quote.walletAddress);
  if (!signed) throw new Error('Wallet did not sign this transaction.');

  const matchedTransfer = (tx.transaction?.message?.instructions || []).some((instruction) => {
    const parsed = instruction?.parsed;
    return instruction?.program === 'system'
      && parsed?.type === 'transfer'
      && parsed?.info?.source === quote.walletAddress
      && parsed?.info?.destination === config.treasury.toBase58()
      && BigInt(parsed?.info?.lamports || 0) === BigInt(quote.paymentAtomic);
  });
  if (!matchedTransfer) throw new Error('The confirmed payment does not match the presale quote.');

  const expectedMemo = `${MEMO_PREFIX}${quoteToken}`;
  const matchedMemo = (tx.transaction?.message?.instructions || []).some((instruction) => (
    instruction?.programId === MEMO_PROGRAM_ID.toBase58()
      || instruction?.program === 'spl-memo'
  ) && instruction?.parsed === expectedMemo);
  if (!matchedMemo) throw new Error('The confirmed payment is missing its presale quote memo.');
}

module.exports = {
  createQuote,
  decimalString,
  getState,
  getLiveSolUsdPrice,
  isConfigured,
  parseDecimalToAtomic,
  pythPriceToUsdMicros,
  signPayload,
  verifyPurchase,
  verifyPayment,
  verifyQuoteToken,
};
