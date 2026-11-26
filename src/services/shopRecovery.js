const attempts = require('../stores/shopAttemptStore');
const payments = require('../stores/shopPaymentStore');
const players = require('../stores/playerStore');
const storage = require('../config/storageConfig');
const shop = require('./shopPaymentService');

async function track(player, input) {
  const attempt = shop.validateRecoveryAttempt(player, input);
  try {
    // A receipt from an older client may already have been credited before
    // attempt tracking existed. Never invite the wallet to sign that quote again.
    const existing = await payments.readPayment(attempt.quoteId);
    if (existing) {
      if (existing.playerId !== attempt.playerId) throw new Error('Purchase attempt does not match the saved record.');
      return { ok: true, quoteId: attempt.quoteId, status: 'confirmed' };
    }
    const row = await attempts.register(attempt);
    return { ok: true, quoteId: row.quote_id, status: row.status };
  } catch (error) {
    if (error?.message === 'Purchase attempt does not match the saved record.') throw error;
    const unavailable = new Error('Purchase recovery is unavailable.');
    unavailable.code = 'RECOVERY_UNAVAILABLE';
    throw unavailable;
  }
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    for (const attempt of await attempts.claim(10, shop.NETWORK)) {
      let status = 'pending', signature = null;
      try {
        const savedPlayer = await players.readPlayer(attempt.player_id);
        if (!savedPlayer) throw new Error('Player no longer exists.');
        // The wallet was bound to this player by the authenticated track request.
        // Cherry sessions can use different wallets under the same player id.
        const player = { ...savedPlayer, walletAddress: attempt.wallet_address };
        let result = await shop.recoverPurchase(player, { quoteToken: attempt.quote_token, signature: attempt.signature });
        // A stale/unrelated signature must not prevent discovery by the quote memo.
        if (result.pending && attempt.signature)
          result = await shop.recoverPurchase(player, { quoteToken: attempt.quote_token });
        if (result.ok === true && result.account) { status = 'confirmed'; signature = result.txHash || null; }
        else if (result.terminal === true) status = 'failed';
      } catch {
        // RPC, quote-secret and account errors are uncertain, never proof of failure.
        console.warn('[battlecities-api] purchase recovery remains pending', attempt.quote_id);
      }
      await attempts.complete(attempt, status, signature);
    }
  } finally { running = false; }
}
function startWorker() {
  if (!storage.hasDatabaseConfig() || process.env.BATTLECITY_SHOP_RECOVERY_WORKER_ENABLED === '0') return () => {};
  const run = () => tick().catch(() => console.error('[battlecities-api] purchase recovery worker failed'));
  run();
  const timer = setInterval(run, 30000);
  timer.unref();
  return () => clearInterval(timer);
}
module.exports = { track, tick, startWorker };
