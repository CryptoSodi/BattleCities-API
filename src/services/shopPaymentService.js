const crypto = require('crypto');
const {
  ComputeBudgetProgram,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} = require('@solana/web3.js');
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} = require('@solana/spl-token');
const economyStore = require('../stores/economyStore');
const shopPaymentStore = require('../stores/shopPaymentStore');
const solanaRpc = require('./solanaRpc');

const NETWORK = 'mainnet-beta';
const TOKEN_MINT = 'Hxs5gXuPHv3Jhm7PYQv9iFMQp5ZYL2Fk6bgWdvQz15bz';
const TREASURY = '6wQz66BgRsX6DVHAD3PDCXjKVpe3LLrj3FGiQwCSZV7F';
const PUBLIC_RPC_URL = 'https://api.mainnet-beta.solana.com';
const TOKEN_DECIMALS = 6;
const QUOTE_TTL_MS = 2 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 1000;
const MEMO_PREFIX = 'BATC-SHOP-V1:';
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

function getConfig() {
  const treasuryValue = String(
    process.env.BATTLECITY_SHOP_TREASURY_ADDRESS
      || process.env.BATTLECITY_PRESALE_TREASURY_ADDRESS
      || TREASURY,
  ).trim();
  const tokenMintValue = String(
    process.env.BATTLECITY_SHOP_TOKEN_MINT
      || process.env.BATTLECITY_PRESALE_TOKEN_MINT
      || TOKEN_MINT,
  ).trim();
  const quoteSecret = String(
    process.env.BATTLECITY_SHOP_QUOTE_SECRET
      || process.env.BATTLECITY_PRESALE_QUOTE_SECRET
      || '',
  );
  const rpcUrl = String(
    process.env.BATTLECITY_SHOP_SOLANA_RPC_URL
      || process.env.BATTLECITY_PRESALE_SOLANA_RPC_URL
      || PUBLIC_RPC_URL,
  );

  let treasury = null;
  let tokenMint = null;
  try {
    treasury = new PublicKey(treasuryValue);
    tokenMint = new PublicKey(tokenMintValue);
  } catch {
    // Configuration validation below returns a stable error.
  }
  return { quoteSecret, rpcUrl, treasury, tokenMint };
}

function assertConfigured(config) {
  if (config.quoteSecret.length < 32
    || config.treasury?.toBase58() !== TREASURY
    || config.tokenMint?.toBase58() !== TOKEN_MINT) {
    throw new Error('Mainnet shop payments are not configured.');
  }
}

async function createQuote(player, input) {
  const config = getConfig();
  assertConfigured(config);
  const itemId = String(input?.itemId || '');
  const currency = input?.currency === 'sol' ? 'sol' : 'token';
  const item = economyStore.getShopCatalogItem(itemId);
  if (item === null) throw new Error('ITEM NOT FOUND');

  let wallet;
  try {
    wallet = new PublicKey(String(input?.walletAddress || ''));
  } catch {
    throw new Error('Invalid wallet address.');
  }

  const amountAtomic = currency === 'sol'
    ? BigInt(Math.round(item.solPrice * 1_000_000_000))
    : BigInt(item.price) * 1_000_000n;
  const issuedAt = Date.now();
  const payload = {
    v: 1,
    id: crypto.randomUUID(),
    playerId: player.id,
    walletAddress: wallet.toBase58(),
    itemId,
    currency,
    amountAtomic: amountAtomic.toString(),
    treasury: config.treasury.toBase58(),
    tokenMint: config.tokenMint.toBase58(),
    network: NETWORK,
    issuedAt,
    expiresAt: issuedAt + QUOTE_TTL_MS,
  };
  const quoteToken = signPayload(payload, config.quoteSecret);
  const connection = new Connection(config.rpcUrl, 'confirmed');
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({ feePayer: wallet, recentBlockhash: blockhash });
  transaction.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }));

  if (currency === 'sol') {
    transaction.add(SystemProgram.transfer({
      fromPubkey: wallet,
      toPubkey: config.treasury,
      lamports: Number(amountAtomic),
    }));
  } else {
    const source = getAssociatedTokenAddressSync(
      config.tokenMint,
      wallet,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const destination = getAssociatedTokenAddressSync(
      config.tokenMint,
      config.treasury,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    transaction.add(createAssociatedTokenAccountIdempotentInstruction(
      wallet,
      destination,
      config.treasury,
      config.tokenMint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ));
    transaction.add(createTransferCheckedInstruction(
      source,
      config.tokenMint,
      destination,
      wallet,
      amountAtomic,
      TOKEN_DECIMALS,
      [],
      TOKEN_2022_PROGRAM_ID,
    ));
  }

  transaction.add(new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(`${MEMO_PREFIX}${payload.id}`, 'utf8'),
  }));
  const simulationTransaction = new VersionedTransaction(new TransactionMessage({
    payerKey: wallet,
    recentBlockhash: blockhash,
    instructions: transaction.instructions,
  }).compileToV0Message());
  const simulation = await connection.simulateTransaction(simulationTransaction, {
    commitment: 'confirmed',
    sigVerify: false,
  });
  if (simulation.value.err) {
    throw new Error(currency === 'sol'
      ? 'The payment could not be prepared. Check your SOL balance.'
      : 'The payment could not be prepared. Check your BATC and SOL balances.');
  }

  return {
    quoteToken,
    transaction: transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }).toString('base64'),
    blockhash,
    lastValidBlockHeight,
    expiresAt: new Date(payload.expiresAt).toISOString(),
    network: NETWORK,
    rpcUrl: PUBLIC_RPC_URL,
    treasury: config.treasury.toBase58(),
    tokenMint: config.tokenMint.toBase58(),
  };
}

// Read-only mainnet balances for an authenticated wallet. This deliberately
// does not use the economy store: SOL and BATC are owned by the wallet, not a
// virtual game account.
async function getWalletBalances(walletAddress) {
  let wallet;
  try {
    wallet = new PublicKey(String(walletAddress || '').trim());
  } catch {
    throw new Error('Invalid wallet address.');
  }

  const tokenMint = new PublicKey(TOKEN_MINT);
  const rpcUrl = String(
    process.env.BATTLECITY_SHOP_SOLANA_RPC_URL || PUBLIC_RPC_URL,
  ).trim();
  const connection = new Connection(rpcUrl, 'confirmed');
  const [lamports, tokenAccounts] = await Promise.all([
    connection.getBalance(wallet, 'confirmed'),
    connection.getParsedTokenAccountsByOwner(wallet, { mint: tokenMint }),
  ]);
  const tokenAmount = tokenAccounts.value.reduce((total, account) => {
    const amount = account.account.data.parsed?.info?.tokenAmount?.amount;
    return total + (typeof amount === 'string' ? Number(amount) : 0);
  }, 0);

  return {
    walletAddress: wallet.toBase58(),
    solBalance: lamports / LAMPORTS_PER_SOL,
    tokenBalance: tokenAmount / 10 ** TOKEN_DECIMALS,
  };
}

async function verifyPurchase(player, input) {
  const config = getConfig();
  assertConfigured(config);
  const signature = String(input?.signature || '');
  if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) {
    throw new Error('Invalid transaction signature.');
  }
  const quoteToken = String(input?.quoteToken || '');
  const quote = verifyQuoteToken(quoteToken, config.quoteSecret);
  validateQuote(quote, config, player);
  const transaction = await solanaRpc.getTransaction(signature, config.rpcUrl);
  if (transaction === null) throw new Error('Transaction is not confirmed on Solana mainnet yet.');
  verifyPayment(transaction, quote, config);
  const confirmedAt = transaction.blockTime
    ? new Date(transaction.blockTime * 1000).toISOString()
    : new Date().toISOString();

  const result = await shopPaymentStore.consumePayment({
    signature,
    quoteId: quote.id,
    playerId: player.id,
    walletAddress: quote.walletAddress,
    itemId: quote.itemId,
    currency: quote.currency,
    amountAtomic: quote.amountAtomic,
    confirmedAt,
  }, async (inserted) => {
    if (inserted) {
      return economyStore.grantOnChainPurchaseForPlayer(
        player,
        quote.itemId,
        quote.currency,
        signature,
        quote.walletAddress,
      );
    }
    const account = await economyStore.readAccount(player.id);
    return economyStore.toPublicAccount(account);
  });

  return {
    ok: true,
    statusText: result.inserted ? `BOUGHT ${quote.itemId.toUpperCase()}` : 'PURCHASE ALREADY VERIFIED',
    txHash: signature,
    account: result.account,
  };
}

function validateQuote(quote, config, player) {
  if (quote.v !== 1
    || quote.playerId !== player.id
    || quote.network !== NETWORK
    || quote.treasury !== config.treasury.toBase58()
    || quote.tokenMint !== config.tokenMint.toBase58()
    || !economyStore.getShopCatalogItem(quote.itemId)
    || (quote.currency !== 'sol' && quote.currency !== 'token')
    || !/^\d+$/.test(String(quote.amountAtomic || ''))
    || !Number.isFinite(quote.issuedAt)
    || !Number.isFinite(quote.expiresAt)
    || quote.expiresAt <= quote.issuedAt
    || quote.expiresAt - quote.issuedAt > QUOTE_TTL_MS
    || Date.now() > quote.expiresAt + MAX_CLOCK_SKEW_MS) {
    throw new Error('Quote does not match the mainnet shop.');
  }
  try {
    if (new PublicKey(quote.walletAddress).toBase58() !== quote.walletAddress) throw new Error();
  } catch {
    throw new Error('Quote contains an invalid wallet address.');
  }
  const item = economyStore.getShopCatalogItem(quote.itemId);
  const expected = quote.currency === 'sol'
    ? BigInt(Math.round(item.solPrice * 1_000_000_000))
    : BigInt(item.price) * 1_000_000n;
  if (BigInt(quote.amountAtomic) !== expected) {
    throw new Error('Quote price no longer matches the shop catalog.');
  }
}

function verifyPayment(transaction, quote, config) {
  if (transaction.meta?.err !== null && transaction.meta?.err !== undefined) {
    throw new Error('Transaction failed on chain.');
  }
  if (!Number.isFinite(transaction.blockTime)) {
    throw new Error('Transaction confirmation time is unavailable.');
  }
  const confirmedAt = transaction.blockTime * 1000;
  if (confirmedAt < quote.issuedAt - MAX_CLOCK_SKEW_MS
    || confirmedAt > quote.expiresAt + MAX_CLOCK_SKEW_MS) {
    throw new Error('Payment was confirmed outside the quote validity window.');
  }
  const accountKeys = transaction.transaction?.message?.accountKeys || [];
  const signed = accountKeys.some((key) => (
    key?.signer === true && key?.pubkey === quote.walletAddress
  ));
  if (!signed) throw new Error('Wallet did not sign this transaction.');

  const instructions = transaction.transaction?.message?.instructions || [];
  const transferMatches = quote.currency === 'sol'
    ? instructions.some((instruction) => {
      const parsed = instruction?.parsed;
      return instruction?.program === 'system'
        && parsed?.type === 'transfer'
        && parsed?.info?.source === quote.walletAddress
        && parsed?.info?.destination === config.treasury.toBase58()
        && BigInt(parsed?.info?.lamports || 0) === BigInt(quote.amountAtomic);
    })
    : matchesTokenTransfer(instructions, quote, config);
  if (!transferMatches) throw new Error('Confirmed payment does not match the shop quote.');

  const expectedMemo = `${MEMO_PREFIX}${quote.id}`;
  const memoMatches = instructions.some((instruction) => (
    instruction?.programId === MEMO_PROGRAM_ID.toBase58()
      || instruction?.program === 'spl-memo'
  ) && instruction?.parsed === expectedMemo);
  if (!memoMatches) throw new Error('Confirmed payment is missing its shop quote memo.');
}

function matchesTokenTransfer(instructions, quote, config) {
  const wallet = new PublicKey(quote.walletAddress);
  const source = getAssociatedTokenAddressSync(
    config.tokenMint, wallet, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  ).toBase58();
  const destination = getAssociatedTokenAddressSync(
    config.tokenMint, config.treasury, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  ).toBase58();
  return instructions.some((instruction) => {
    const parsed = instruction?.parsed;
    const info = parsed?.info;
    return instruction?.programId === TOKEN_2022_PROGRAM_ID.toBase58()
      && parsed?.type === 'transferChecked'
      && info?.source === source
      && info?.destination === destination
      && info?.authority === quote.walletAddress
      && info?.mint === config.tokenMint.toBase58()
      && Number(info?.tokenAmount?.decimals) === TOKEN_DECIMALS
      && BigInt(info?.tokenAmount?.amount || 0) === BigInt(quote.amountAtomic);
  });
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

module.exports = {
  NETWORK,
  TOKEN_MINT,
  TREASURY,
  createQuote,
  getWalletBalances,
  verifyPayment,
  verifyPurchase,
};
