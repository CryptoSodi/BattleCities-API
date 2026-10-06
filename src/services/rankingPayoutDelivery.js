const fs = require('fs').promises;
const { Connection, Keypair, PublicKey, Transaction } = require('@solana/web3.js');
const { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
  getAssociatedTokenAddressSync, getAccount } = require('@solana/spl-token');
const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;
const storage = require('../config/storageConfig');
const store = require('../stores/competitionStore');
const skr = require('./skrToken');

async function prepare(connection, payout) {
  const keypairPath = process.env.BATTLECITY_RANKING_REWARD_KEYPAIR_PATH;
  const authorityAddress = process.env.BATTLECITY_RANKING_REWARD_AUTHORITY_ADDRESS;
  if (!keypairPath || !authorityAddress) throw new Error('Ranking reward authority is not configured.');
  const stat = await fs.stat(keypairPath);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('Reward keypair permissions must be 600.');
  const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await fs.readFile(keypairPath, 'utf8'))));
  if (keypair.publicKey.toBase58() !== authorityAddress) throw new Error('Reward authority does not match its keypair.');
  const token = payout.tokenConfig;
  if (token.network !== 'mainnet-beta') throw new Error('Ranking rewards must use mainnet.');
  await skr.validateMint(connection, token);
  const mint = new PublicKey(token.mint), program = new PublicKey(token.programId);
  const owner = new PublicKey(payout.walletAddress);
  const source = getAssociatedTokenAddressSync(mint, keypair.publicKey, false, program);
  const destination = getAssociatedTokenAddressSync(mint, owner, false, program);
  const amount = skr.atomic(payout.amount, token.decimals);
  const account = await getAccount(connection, source, 'confirmed', program);
  if (!account.owner.equals(keypair.publicKey) || !account.mint.equals(mint) || account.amount < amount) {
    throw new Error('Ranking reward wallet has insufficient tokens or a mismatched account.');
  }
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
  const transaction = new Transaction({ feePayer: keypair.publicKey, recentBlockhash: blockhash });
  transaction.add(createAssociatedTokenAccountIdempotentInstruction(keypair.publicKey, destination, owner, mint, program));
  transaction.add(createTransferCheckedInstruction(source, mint, destination, keypair.publicKey, amount, token.decimals, [], program));
  transaction.sign(keypair);
  return { signature: bs58.encode(transaction.signature), rawTransaction: transaction.serialize().toString('base64'), blockhash, lastValidBlockHeight };
}
// A replacement is safe only after finalized expiry and a second history lookup.
async function deliveryState(connection, delivery) {
  const lookup = async () => (await connection.getSignatureStatuses([delivery.signature], { searchTransactionHistory: true })).value[0];
  let status = await lookup();
  if (status && !status.err && ['confirmed', 'finalized'].includes(status.confirmationStatus)) return 'paid';
  if (status && !status.err) return 'wait';
  const height = await connection.getBlockHeight('finalized');
  if (height <= Number(delivery.lastValidBlockHeight)) return status?.err ? 'wait' : 'retry';
  status = await lookup();
  if (status && !status.err) return ['confirmed', 'finalized'].includes(status.confirmationStatus) ? 'paid' : 'wait';
  return 'replace';
}
async function deliver(id, connection = null) {
  if (process.env.BATTLECITY_LEADERBOARD_REWARDS_ENABLED !== '1' || !storage.hasDatabaseConfig()) {
    throw new Error('Ranking payouts require an enabled worker and PostgreSQL.');
  }
  connection ||= new Connection(process.env.BATTLECITY_RANKING_REWARD_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
  let payout = await store.getPayout(id);
  if (!payout || payout.status === 'wallet_required') throw new Error('Payout has no destination wallet.');
  if (payout.status === 'paid') return payout;
  if (payout.delivery) {
    const status = await deliveryState(connection, payout.delivery);
    if (status === 'paid') return store.finishPayout(id, payout.delivery.signature);
    if (status === 'wait') return payout;
    if (status === 'replace') payout = await store.preparePayout(id, payout.delivery.signature, await prepare(connection, payout));
  } else {
    payout = await store.preparePayout(id, null, await prepare(connection, payout));
  }
  if (payout.status === 'paid') return payout;
  // The exact signed bytes have committed before any network submission.
  try {
    const d = payout.delivery;
    const signature = await connection.sendRawTransaction(Buffer.from(d.rawTransaction, 'base64'), { maxRetries: 3, skipPreflight: false });
    if (signature !== d.signature) throw new Error('Unexpected payout signature.');
    const confirmation = await connection.confirmTransaction({ signature, blockhash: d.blockhash,
      lastValidBlockHeight: Number(d.lastValidBlockHeight) }, 'confirmed');
    if (confirmation.value.err) throw new Error('Payout failed on chain.');
    return store.finishPayout(id, signature);
  } catch (error) {
    if (await deliveryState(connection, payout.delivery) === 'paid') return store.finishPayout(id, payout.delivery.signature);
    await store.finishPayout(id, payout.delivery.signature, 'Transfer pending retry.');
    throw error;
  }
}
module.exports = { deliver, deliveryState };
