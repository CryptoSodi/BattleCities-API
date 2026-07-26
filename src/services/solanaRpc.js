// Minimal Solana JSON-RPC client + swap-fact derivation for trading boost
// verification. No SDK dependency — one HTTP call and pure JSON analysis.
//
// The swap venue is Raydium, but verification is venue-agnostic: we fetch the
// confirmed transaction by signature and read what actually moved in/out of
// the player's wallet, so any DEX route (Raydium, aggregators) verifies the
// same way. The token launches on TESTNET first, so the default RPC endpoint
// is testnet; point BATTLECITY_SOLANA_RPC_URL at mainnet later.

function getRpcUrl() {
  return (
    process.env.BATTLECITY_SOLANA_RPC_URL || 'https://api.testnet.solana.com'
  );
}

// Fetches a confirmed transaction (jsonParsed). Returns null when the
// signature is unknown/not yet confirmed; throws on transport errors.
async function getTransaction(signature) {
  if (typeof fetch !== 'function') {
    throw new Error('global fetch is not available in this runtime');
  }

  const response = await fetch(getRpcUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [
        signature,
        {
          encoding: 'jsonParsed',
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`RPC responded ${response.status}`);
  }

  const body = await response.json();
  if (body.error !== undefined) {
    throw new Error(`RPC error: ${body.error.message || body.error.code}`);
  }

  return body.result || null;
}

// Pure analysis of a getTransaction result: derives which non-stable mint the
// wallet swapped and the USD value of the stable side. Trustless — the
// client-declared mints/amounts are ignored entirely.
//
// options: { stableMints: string[], solPriceUsd: number }
// returns: { ok: true, boostMint, volumeUsd } | { ok: false, error }
function deriveSwapFromTransaction(tx, walletAddress, options) {
  if (typeof tx !== 'object' || tx === null || typeof tx.meta !== 'object') {
    return { ok: false, error: 'Malformed transaction' };
  }
  if (tx.meta.err !== null && tx.meta.err !== undefined) {
    return { ok: false, error: 'Transaction failed on chain' };
  }

  const accountKeys = tx.transaction?.message?.accountKeys;
  if (!Array.isArray(accountKeys)) {
    return { ok: false, error: 'Malformed transaction' };
  }

  const walletIndex = accountKeys.findIndex(
    (key) => (typeof key === 'string' ? key : key.pubkey) === walletAddress,
  );
  const walletKey = walletIndex === -1 ? null : accountKeys[walletIndex];
  const isSigner =
    walletKey !== null &&
    (typeof walletKey === 'string' ? false : walletKey.signer === true);
  if (!isSigner) {
    return { ok: false, error: 'Wallet did not sign this transaction' };
  }

  const stableMints = new Set(options.stableMints || []);
  const solPriceUsd = Number(options.solPriceUsd) || 0;

  // Wallet-owned SPL token balance deltas by mint.
  const deltasByMint = new Map();
  const collect = (balances, sign) => {
    (Array.isArray(balances) ? balances : []).forEach((balance) => {
      if (balance.owner !== walletAddress) {
        return;
      }
      const amount = Number(balance.uiTokenAmount?.uiAmount) || 0;
      deltasByMint.set(
        balance.mint,
        (deltasByMint.get(balance.mint) || 0) + sign * amount,
      );
    });
  };
  collect(tx.meta.preTokenBalances, -1);
  collect(tx.meta.postTokenBalances, 1);

  // The boosted side: the wallet's largest non-stable token movement.
  let boostMint = null;
  let boostAmount = 0;
  // The stable side in USD: stable-token movement, or native SOL movement.
  let stableUsd = 0;

  for (const [mint, delta] of deltasByMint) {
    const magnitude = Math.abs(delta);
    if (magnitude === 0) {
      continue;
    }
    if (stableMints.has(mint)) {
      // USDC/USDT are USD-pegged 1:1; wrapped SOL is priced below.
      stableUsd = Math.max(
        stableUsd,
        isWrappedSol(mint) ? magnitude * solPriceUsd : magnitude,
      );
      continue;
    }
    if (magnitude > boostAmount) {
      boostAmount = magnitude;
      boostMint = mint;
    }
  }

  // Native (unwrapped) SOL movement of the wallet account itself. Includes
  // the tx fee, which is negligible against real swap volume.
  const preLamports = Number(tx.meta.preBalances?.[walletIndex]) || 0;
  const postLamports = Number(tx.meta.postBalances?.[walletIndex]) || 0;
  const solMoved = Math.abs(postLamports - preLamports) / 1e9;
  stableUsd = Math.max(stableUsd, solMoved * solPriceUsd);

  if (boostMint === null) {
    return { ok: false, error: 'No eligible token movement found' };
  }
  if (stableUsd <= 0) {
    return { ok: false, error: 'No stable-side volume found' };
  }

  return {
    ok: true,
    boostMint,
    volumeUsd: Math.round(stableUsd * 100) / 100,
  };
}

function isWrappedSol(mint) {
  return mint === 'So11111111111111111111111111111111111111112';
}

module.exports = {
  deriveSwapFromTransaction,
  getRpcUrl,
  getTransaction,
};
