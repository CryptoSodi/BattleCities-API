const { verifyLaunchToken } = require('@cherrydotfun/miniapp-sdk');
const walletAuth = require('./walletAuth');
const { PublicKey } = require('@solana/web3.js');

const APP_ID = 'c0dcc3df-8b13-445b-afa1-573c8c567315';
function validSolanaWallet(value) {
  if (!walletAuth.isValidWalletAddress(value)) return false;
  try { return new PublicKey(value).toBase58() === value; } catch { return false; }
}

// Factory injection is only for local cryptographic tests. The production
// verifier below always uses the SDK's fixed Cherry issuer and JWKS endpoint.
function createVerifier(options = {}) {
  return async function verifyCherryLaunchToken(token) {
    if (typeof token !== 'string' || token.length === 0 || token.length > 16384) throw new Error('Invalid Cherry token');
    const claims = await verifyLaunchToken(token, {
      ...options,
      appId: APP_ID,
      issuer: 'https://chat.cherry.fun',
      requireAudience: true,
      clockTolerance: 0,
      scope: 'launch',
    });
    if (claims.app_id !== APP_ID || !validSolanaWallet(claims.sub)) throw new Error('Invalid Cherry identity');
    const userKey = claims.cherry_id ?? claims.sub;
    if (typeof userKey !== 'string' || !userKey.trim() || userKey.length > 256) throw new Error('Invalid Cherry identity');
    const wallet = claims.payment_wallet ?? claims.sub;
    if (!validSolanaWallet(wallet)) throw new Error('Invalid Cherry payment wallet');
    return { userKey, wallet, claims };
  };
}

module.exports = { APP_ID, createVerifier, verifyCherryLaunchToken: createVerifier() };
