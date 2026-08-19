const fs = require('fs').promises;
const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} = require('@solana/web3.js');
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} = require('@solana/spl-token');
const presaleStore = require('../stores/presaleStore');

const CONFIRMED_STATUSES = new Set(['confirmed', 'finalized']);
let cachedKeypair = null;
let cachedKeypairPath = null;

async function deliverPurchase(purchase, config) {
  if (purchase.deliveryStatus === 'delivered') return purchase;
  const connection = new Connection(config.rpcUrl, 'confirmed');
  let current = purchase;

  try {
    if (current.deliveryTransactionSignature && current.deliveryRawTransaction) {
      const resolved = await resolveExistingDelivery(connection, current);
      if (resolved.status === 'delivered') {
        return presaleStore.markDeliveryDelivered(
          current.signature,
          current.deliveryTransactionSignature,
        );
      }
      if (resolved.status === 'retry-same') {
        return broadcastPreparedDelivery(connection, current);
      }
      await presaleStore.markDeliveryFailed(
        current.signature,
        current.deliveryTransactionSignature,
        resolved.reason,
      );
      current = await presaleStore.findBySignature(current.signature);
    }

    const prepared = await createPreparedDelivery(connection, current, config);
    current = await presaleStore.prepareDelivery(current.signature, prepared);
    return broadcastPreparedDelivery(connection, current);
  } catch (error) {
    const reason = deliveryErrorMessage(error);
    if (current?.deliveryTransactionSignature) {
      return presaleStore.markDeliveryFailed(
        current.signature,
        current.deliveryTransactionSignature,
        reason,
      );
    }
    return presaleStore.markDeliveryPreparationFailed(current.signature, reason);
  }
}

async function resolveExistingDelivery(connection, purchase) {
  const statusResponse = await connection.getSignatureStatuses(
    [purchase.deliveryTransactionSignature],
    { searchTransactionHistory: true },
  );
  const status = statusResponse.value[0];
  if (status?.err) {
    return { status: 'replace', reason: `Previous delivery failed on chain: ${JSON.stringify(status.err)}` };
  }
  if (status && CONFIRMED_STATUSES.has(status.confirmationStatus)) {
    return { status: 'delivered' };
  }

  const lastValid = Number(purchase.deliveryLastValidBlockHeight);
  const currentHeight = await connection.getBlockHeight('confirmed');
  if (Number.isFinite(lastValid) && currentHeight <= lastValid) {
    return { status: 'retry-same' };
  }
  return { status: 'replace', reason: 'Previous delivery transaction expired before confirmation.' };
}

async function createPreparedDelivery(connection, purchase, config) {
  const distributor = await loadDistributionKeypair(config);
  const mint = config.tokenMint;
  const buyer = new PublicKey(purchase.walletAddress);
  const source = getAssociatedTokenAddressSync(
    mint,
    distributor.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const destination = getAssociatedTokenAddressSync(
    mint,
    buyer,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const sourceAccount = await getAccount(connection, source, 'confirmed', TOKEN_2022_PROGRAM_ID);
  const amount = BigInt(purchase.tokenMicros);
  if (!sourceAccount.owner.equals(distributor.publicKey) || !sourceAccount.mint.equals(mint)) {
    throw new Error('Distribution token account does not match the configured wallet and mint.');
  }
  if (sourceAccount.amount < amount) throw new Error('Distribution wallet has insufficient BATC.');
  let destinationAccount;
  try {
    destinationAccount = await getAccount(connection, destination, 'confirmed', TOKEN_2022_PROGRAM_ID);
  } catch {
    throw new Error('Buyer BATC token account is missing. Request a new quote and approve the account-creation fee in Phantom.');
  }
  if (!destinationAccount.owner.equals(buyer) || !destinationAccount.mint.equals(mint)) {
    throw new Error('Buyer BATC token account does not match the configured wallet and mint.');
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({
    feePayer: distributor.publicKey,
    recentBlockhash: blockhash,
  });
  transaction.add(createTransferCheckedInstruction(
    source,
    mint,
    destination,
    distributor.publicKey,
    amount,
    config.tokenDecimals,
    [],
    TOKEN_2022_PROGRAM_ID,
  ));
  transaction.sign(distributor);
  const raw = transaction.serialize();
  return {
    signature: bs58.encode(transaction.signature),
    rawTransaction: raw.toString('base64'),
    blockhash,
    lastValidBlockHeight,
  };
}

async function broadcastPreparedDelivery(connection, purchase) {
  const raw = Buffer.from(purchase.deliveryRawTransaction, 'base64');
  const signature = purchase.deliveryTransactionSignature;
  try {
    const submittedSignature = await connection.sendRawTransaction(raw, {
      maxRetries: 3,
      skipPreflight: false,
    });
    if (submittedSignature !== signature) throw new Error('RPC returned an unexpected delivery signature.');
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash: purchase.deliveryBlockhash,
      lastValidBlockHeight: Number(purchase.deliveryLastValidBlockHeight),
    }, 'confirmed');
    if (confirmation.value.err) {
      throw new Error(`BATC delivery failed on chain: ${JSON.stringify(confirmation.value.err)}`);
    }
    return presaleStore.markDeliveryDelivered(purchase.signature, signature);
  } catch (error) {
    const status = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const value = status.value[0];
    if (value && !value.err && CONFIRMED_STATUSES.has(value.confirmationStatus)) {
      return presaleStore.markDeliveryDelivered(purchase.signature, signature);
    }
    return presaleStore.markDeliveryFailed(
      purchase.signature,
      signature,
      deliveryErrorMessage(error),
    );
  }
}

async function loadDistributionKeypair(config) {
  if (!config.distributionKeypairPath) throw new Error('Distribution keypair path is not configured.');
  if (cachedKeypair && cachedKeypairPath === config.distributionKeypairPath) return cachedKeypair;
  const stat = await fs.stat(config.distributionKeypairPath);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('Distribution keypair permissions must be 600 or stricter.');
  }
  const encoded = JSON.parse(await fs.readFile(config.distributionKeypairPath, 'utf8'));
  if (!Array.isArray(encoded) || encoded.length !== 64) throw new Error('Distribution keypair file is invalid.');
  const keypair = Keypair.fromSecretKey(Uint8Array.from(encoded));
  if (!config.distributionAddress || !keypair.publicKey.equals(config.distributionAddress)) {
    throw new Error('Distribution keypair does not match the configured address.');
  }
  cachedKeypair = keypair;
  cachedKeypairPath = config.distributionKeypairPath;
  return keypair;
}

function deliveryErrorMessage(error) {
  const message = String(error?.message || error || 'BATC delivery failed.');
  return message.replace(/[\r\n]+/g, ' ').slice(0, 1000);
}

module.exports = {
  deliverPurchase,
  deliveryErrorMessage,
};
