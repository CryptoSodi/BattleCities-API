const database = require('../database');

const TABLE_NAME = 'battlecity_batc_powerup_drops';

async function issueRoll(input) {
  await database.assertMigrationsApplied();
  return database.withTransaction(async () => {
    const pool = database.getPool();
    await pool.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.playerId]);

    const existing = await pool.query(
      `SELECT * FROM ${TABLE_NAME} WHERE player_id = $1 AND request_id = $2`,
      [input.playerId, input.requestId],
    );
    if (existing.rowCount > 0) return fromRow(existing.rows[0]);

    const recent = await pool.query(
      `SELECT COUNT(*)::integer AS rolls
       FROM ${TABLE_NAME}
       WHERE player_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'`,
      [input.playerId],
    );
    if (Number(recent.rows[0]?.rolls || 0) >= input.maxRollsPerDay) {
      const error = new Error('Daily BATC drop roll limit reached.');
      error.code = 'DROP_ROLL_LIMIT';
      throw error;
    }

    const reserved = await pool.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE player_id = $1), 0)::integer AS player_total,
         COALESCE(SUM(amount), 0)::integer AS global_total
       FROM ${TABLE_NAME}
       WHERE amount > 0
         AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
         AND (
           status IN ('delivering', 'delivered') OR
           (status IN ('issued', 'failed') AND (claimed_at IS NOT NULL OR expires_at > NOW()))
         )`,
      [input.playerId],
    );
    const totals = reserved.rows[0] || {};
    const amount = (
      Number(totals.player_total || 0) + input.amount <= input.maxPlayerBatcPerDay &&
      Number(totals.global_total || 0) + input.amount <= input.maxGlobalBatcPerDay
    ) ? input.amount : 0;
    const status = amount > 0 ? 'issued' : 'none';

    const inserted = await pool.query(
      `INSERT INTO ${TABLE_NAME}
        (id, request_id, player_id, wallet_address, level_number, amount,
         status, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)
       RETURNING *`,
      [input.id, input.requestId, input.playerId, input.walletAddress,
        input.levelNumber, amount, status, input.expiresAt],
    );
    return fromRow(inserted.rows[0]);
  });
}

async function findById(id) {
  await database.assertMigrationsApplied();
  const result = await database.getPool().query(
    `SELECT * FROM ${TABLE_NAME} WHERE id = $1`,
    [id],
  );
  return result.rowCount > 0 ? fromRow(result.rows[0]) : null;
}

async function prepareDelivery(id, prepared) {
  await database.assertMigrationsApplied();
  const result = await database.getPool().query(
    `UPDATE ${TABLE_NAME}
     SET status = 'delivering', claimed_at = COALESCE(claimed_at, NOW()),
         delivery_signature = $2,
         delivery_raw_transaction = $3, delivery_blockhash = $4,
         delivery_last_valid_block_height = $5, delivery_error = NULL
     WHERE id = $1 AND delivery_signature IS NULL AND status IN ('issued', 'failed')
     RETURNING *`,
    [id, prepared.signature, prepared.rawTransaction, prepared.blockhash,
      prepared.lastValidBlockHeight],
  );
  return result.rowCount > 0 ? fromRow(result.rows[0]) : findById(id);
}

async function replaceDelivery(id, previousSignature, prepared) {
  const result = await database.getPool().query(
    `UPDATE ${TABLE_NAME}
     SET status = 'delivering', claimed_at = COALESCE(claimed_at, NOW()),
         delivery_signature = $3,
         delivery_raw_transaction = $4, delivery_blockhash = $5,
         delivery_last_valid_block_height = $6, delivery_error = NULL
     WHERE id = $1 AND delivery_signature = $2 AND status <> 'delivered'
     RETURNING *`,
    [id, previousSignature, prepared.signature, prepared.rawTransaction,
      prepared.blockhash, prepared.lastValidBlockHeight],
  );
  return result.rowCount > 0 ? fromRow(result.rows[0]) : findById(id);
}

async function markDelivered(id, signature) {
  const result = await database.getPool().query(
    `UPDATE ${TABLE_NAME}
     SET status = 'delivered', claimed_at = COALESCE(claimed_at, NOW()),
         delivery_error = NULL
     WHERE id = $1 AND delivery_signature = $2
     RETURNING *`,
    [id, signature],
  );
  return result.rowCount > 0 ? fromRow(result.rows[0]) : findById(id);
}

async function markFailed(id, signature, reason) {
  const result = await database.getPool().query(
    `UPDATE ${TABLE_NAME}
     SET status = 'failed', delivery_error = $3
     WHERE id = $1 AND delivery_signature = $2 AND status <> 'delivered'
     RETURNING *`,
    [id, signature, reason],
  );
  return result.rowCount > 0 ? fromRow(result.rows[0]) : findById(id);
}

function fromRow(row) {
  return {
    id: row.id,
    requestId: row.request_id,
    playerId: row.player_id,
    walletAddress: row.wallet_address,
    levelNumber: Number(row.level_number),
    amount: Number(row.amount),
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    claimedAt: row.claimed_at ? new Date(row.claimed_at).toISOString() : null,
    deliverySignature: row.delivery_signature || null,
    deliveryRawTransaction: row.delivery_raw_transaction || null,
    deliveryBlockhash: row.delivery_blockhash || null,
    deliveryLastValidBlockHeight: row.delivery_last_valid_block_height === null
      ? null : Number(row.delivery_last_valid_block_height),
    deliveryError: row.delivery_error || null,
  };
}

module.exports = {
  findById,
  issueRoll,
  markDelivered,
  markFailed,
  prepareDelivery,
  replaceDelivery,
};
