const fs = require('fs').promises;
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const { getAccount, getAssociatedTokenAddressSync } = require('@solana/spl-token');
const skr = require('./skrToken');
const shop = require('./shopPaymentService');
let cached;
let checked = 0;
function exact(amount, decimals) {
  const scale = 10n ** BigInt(decimals);
  const tail = (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return String(amount / scale) + (tail ? '.' + tail : '');
}
async function status() {
  if (cached && Date.now() - checked < 30000) return cached;
  let token = null;
  try { token = skr.config(); } catch { /* Configuration is reported below. */ }
  const config = shop.getConfig();
  const address = process.env.BATTLECITY_RANKING_REWARD_AUTHORITY_ADDRESS || null;
  const wallet = { configured: false, address, keypairValid: false, solBalance: null, skrBalance: null,
    checkedAt: new Date().toISOString(), error: null };
  const value = { workerEnabled: process.env.BATTLECITY_COMPETITIONS_WORKER_ENABLED === '1',
    deliveryEnabled: process.env.BATTLECITY_LEADERBOARD_REWARDS_ENABLED === '1',
    skr: { configured: !!token, mint: token?.mint || null, decimals: token?.decimals ?? null, programId: token?.programId || null },
    shop: { configured: config.quoteSecret.length >= 32 && config.treasury?.toBase58() === shop.TREASURY
      && config.tokenMint?.toBase58() === shop.TOKEN_MINT, treasury: config.treasury?.toBase58() || null },
    rewardWallet: wallet, blockers: [] };
  const keyFile = process.env.BATTLECITY_RANKING_REWARD_KEYPAIR_PATH;
  if (keyFile && address) {
    try {
      const stat = await fs.lstat(keyFile);
      if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error();
      const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await fs.readFile(keyFile, 'utf8'))));
      wallet.keypairValid = keypair.publicKey.toBase58() === address;
      wallet.configured = wallet.keypairValid;
    } catch { wallet.error = 'Reward wallet key configuration is unavailable or invalid.'; }
    if (wallet.configured && token) {
      try {
        const connection = new Connection(process.env.BATTLECITY_RANKING_REWARD_RPC_URL || 'https://api.mainnet-beta.solana.com', {
          commitment: 'confirmed', disableRetryOnRateLimit: true,
          fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(6000) }),
        });
        await skr.validateMint(connection, token);
        const publicKey = new PublicKey(address);
        wallet.solBalance = exact(BigInt(await connection.getBalance(publicKey, 'confirmed')), 9);
        const ata = getAssociatedTokenAddressSync(new PublicKey(token.mint), publicKey, false, new PublicKey(token.programId));
        const info = await connection.getAccountInfo(ata, 'confirmed');
        wallet.skrBalance = info ? exact((await getAccount(connection, ata, 'confirmed', new PublicKey(token.programId))).amount, token.decimals) : '0';
      } catch { wallet.error = 'Could not verify reward wallet balances and token configuration.'; }
    }
  }
  if (!value.skr.configured) value.blockers.push('Configure the SKR mint and precision on the API server.');
  if (!value.shop.configured) value.blockers.push('Configure shop checkout on the API server.');
  if (!value.workerEnabled) value.blockers.push('Competition closing is paused on the API server.');
  if (!value.deliveryEnabled) value.blockers.push('Prize transfers are paused on the API server.');
  if (!wallet.configured) value.blockers.push('Configure a dedicated reward wallet on the API server.');
  if (wallet.configured && wallet.solBalance === '0') value.blockers.push('Fund the reward wallet with SOL for fees and token-account rent.');
  if (wallet.configured && wallet.skrBalance === '0') value.blockers.push('Fund the reward wallet with SKR before enabling prizes.');
  if (wallet.error) value.blockers.push(wallet.error);
  checked = Date.now(); cached = value;
  return value;
}
module.exports = { status, exact };
