const crypto = require('crypto');
const database = require('../database');
const storage = require('../config/storageConfig');

function requireDatabase() {
  if (!storage.hasDatabaseConfig()) {
    const error = new Error('Purchase recovery requires PostgreSQL.');
    error.code = 'DATABASE_REQUIRED';
    throw error;
  }
}
async function register(attempt) {
  requireDatabase();
  await database.assertMigrationsApplied();
  const result = await database.getPool().query(`
    INSERT INTO battlecity_shop_purchase_attempts
      (quote_id, player_id, wallet_address, item_id, currency, amount_atomic, token_decimals,
       network, quote_token, signature, issued_at, expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (quote_id) DO UPDATE SET
      signature = COALESCE(battlecity_shop_purchase_attempts.signature, EXCLUDED.signature),
      next_check_at = CASE WHEN battlecity_shop_purchase_attempts.status = 'pending'
        THEN LEAST(battlecity_shop_purchase_attempts.next_check_at, NOW())
        ELSE battlecity_shop_purchase_attempts.next_check_at END,
      updated_at = NOW()
    WHERE battlecity_shop_purchase_attempts.player_id = EXCLUDED.player_id
      AND battlecity_shop_purchase_attempts.wallet_address = EXCLUDED.wallet_address
      AND battlecity_shop_purchase_attempts.quote_token = EXCLUDED.quote_token
    RETURNING quote_id, status`,
  [attempt.quoteId, attempt.playerId, attempt.walletAddress, attempt.itemId, attempt.currency,
    attempt.amountAtomic, attempt.decimals, attempt.network, attempt.quoteToken, attempt.signature || null,
    new Date(attempt.issuedAt).toISOString(), new Date(attempt.expiresAt).toISOString()]);
  if (!result.rowCount) throw new Error('Purchase attempt does not match the saved record.');
  return result.rows[0];
}
async function claim(limit = 10, network) {
  requireDatabase();
  if (!network) throw new Error('Recovery network is required.');
  await database.assertMigrationsApplied();
  const claimId = crypto.randomUUID();
  const result = await database.getPool().query(`
    WITH due AS (
      SELECT quote_id FROM battlecity_shop_purchase_attempts
      WHERE status = 'pending' AND network = $2 AND next_check_at <= NOW()
        AND (claimed_until IS NULL OR claimed_until < NOW())
      ORDER BY next_check_at, created_at
      FOR UPDATE SKIP LOCKED LIMIT $1
    )
    UPDATE battlecity_shop_purchase_attempts a
    SET claim_id = $3, claimed_until = NOW() + INTERVAL '5 minutes'
    FROM due WHERE a.quote_id = due.quote_id RETURNING a.*`, [limit, network, claimId]);
  return result.rows;
}
async function complete(attempt, status, signature = null) {
  requireDatabase();
  const delay = Math.min(3600, 30 * (2 ** Math.min(Number(attempt.check_count || 0), 7)));
  const result = await database.getPool().query(`
    UPDATE battlecity_shop_purchase_attempts SET status = $3,
      signature = COALESCE(signature, $4), last_checked_at = NOW(), updated_at = NOW(),
      check_count = check_count + 1, next_check_at = NOW() + ($5 * INTERVAL '1 second'),
      claim_id = NULL, claimed_until = NULL
    WHERE quote_id = $1 AND claim_id = $2 AND status = 'pending'`,
  [attempt.quote_id, attempt.claim_id, status, signature, delay]);
  return result.rowCount === 1;
}
async function listPending({ limit = 50, offset = 0 } = {}) {
  requireDatabase();
  await database.assertMigrationsApplied();
  limit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 50));
  offset = Math.min(1000000, Math.max(0, Number.parseInt(offset, 10) || 0));
  const result = await database.getPool().query(`
    SELECT a.quote_id, a.player_id, a.wallet_address, a.item_id, a.currency,
      a.amount_atomic::text, a.token_decimals, a.network, a.signature, a.status,
      a.created_at, a.last_checked_at, a.next_check_at, a.check_count, p.display_name
    FROM battlecity_shop_purchase_attempts a
    LEFT JOIN battlecity_players p ON p.id = a.player_id
    WHERE a.status = 'pending'
    ORDER BY a.created_at DESC, a.quote_id DESC LIMIT $1 OFFSET $2`, [limit + 1, offset]);
  return { items: result.rows.slice(0, limit).map(r => ({
    quoteId: r.quote_id, playerId: r.player_id, displayName: r.display_name,
    walletAddress: r.wallet_address, itemId: r.item_id, currency: r.currency,
    amountAtomic: r.amount_atomic, decimals: r.token_decimals, network: r.network,
    signature: r.signature, status: r.status, createdAt: r.created_at,
    lastCheckedAt: r.last_checked_at, nextCheckAt: r.next_check_at, checkCount: r.check_count,
  })), limit, offset, hasMore: result.rows.length > limit };
}
module.exports = { register, claim, complete, listPending };
