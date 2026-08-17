const fs = require('fs').promises;
const path = require('path');
const database = require('../database');
const storageConfig = require('../config/storageConfig');

const TABLE_NAME = 'battlecity_presale_allocations';
const QUOTES_TABLE_NAME = 'battlecity_presale_quotes';
const PRESALE_LOCK_ID = 424242017;
let fileOperation = Promise.resolve();

function getDataFile() {
  return (
    process.env.BATTLECITY_PRESALE_FILE ||
    path.join(process.cwd(), 'server-data', 'presale', 'allocations.json')
  );
}

function hasPersistentStore() {
  return storageConfig.hasDatabaseConfig();
}

async function listAllocations() {
  if (hasPersistentStore()) {
    await database.assertMigrationsApplied();
    const result = await database.getPool().query(
      `
        SELECT signature, quote_id, wallet_address, payment_method,
               payment_atomic, usd_micros, token_micros, stage_id,
               confirmed_at
        FROM ${TABLE_NAME}
        ORDER BY confirmed_at ASC, signature ASC
      `,
    );
    return result.rows.map(normalizeRecord);
  }

  try {
    const value = JSON.parse(await fs.readFile(getDataFile(), 'utf8'));
    return Array.isArray(value.records) ? value.records.map(normalizeRecord) : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function findBySignature(signature) {
  if (hasPersistentStore()) {
    await database.assertMigrationsApplied();
    const result = await database.getPool().query(
      `
        SELECT signature, quote_id, wallet_address, payment_method,
               payment_atomic, usd_micros, token_micros, stage_id,
               confirmed_at
        FROM ${TABLE_NAME}
        WHERE signature = $1
      `,
      [signature],
    );
    return result.rowCount === 1 ? normalizeRecord(result.rows[0]) : null;
  }

  return (await listAllocations()).find((record) => record.signature === signature) || null;
}

async function reserveQuote(quote, maxStageTokenMicros) {
  if (hasPersistentStore()) {
    await database.assertMigrationsApplied();
    return database.withTransaction(async () => {
      const pool = database.getPool();
      await pool.query('SELECT pg_advisory_xact_lock($1)', [PRESALE_LOCK_ID]);
      const capacity = await pool.query(
        `
          SELECT
            COALESCE((SELECT SUM(token_micros) FROM ${TABLE_NAME} WHERE stage_id = $1), 0) AS sold,
            COALESCE((SELECT SUM(token_micros) FROM ${QUOTES_TABLE_NAME}
                      WHERE stage_id = $1 AND consumed_signature IS NULL AND expires_at > NOW()), 0) AS reserved
        `,
        [quote.stageId],
      );
      const committed = BigInt(capacity.rows[0].sold) + BigInt(capacity.rows[0].reserved);
      if (committed + BigInt(quote.tokenMicros) > BigInt(maxStageTokenMicros)) {
        const error = new Error('The current stage no longer has enough BATC available. Request a new quote.');
        error.code = 'PRESALE_STAGE_CAPACITY';
        throw error;
      }
      await pool.query(
        `
          INSERT INTO ${QUOTES_TABLE_NAME}
            (quote_id, wallet_address, payment_atomic, usd_micros, token_micros, stage_id, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [quote.quoteId, quote.walletAddress, quote.paymentAtomic, quote.usdMicros,
          quote.tokenMicros, quote.stageId, quote.expiresAt],
      );
    });
  }

  return withFileLock(async () => {
    const state = await readFileState();
    const sold = state.records
      .filter((item) => item.stageId === quote.stageId)
      .reduce((sum, item) => sum + BigInt(item.tokenMicros), 0n);
    const now = Date.now();
    const reserved = state.quotes
      .filter((item) => item.stageId === quote.stageId && !item.consumedSignature
        && new Date(item.expiresAt).getTime() > now)
      .reduce((sum, item) => sum + BigInt(item.tokenMicros), 0n);
    if (sold + reserved + BigInt(quote.tokenMicros) > BigInt(maxStageTokenMicros)) {
      const error = new Error('The current stage no longer has enough BATC available. Request a new quote.');
      error.code = 'PRESALE_STAGE_CAPACITY';
      throw error;
    }
    state.quotes.push({ ...quote, consumedSignature: null });
    await writeFileState(state);
  });
}

async function consumeQuoteAndRecordAllocation(record, maxStageTokenMicros) {
  if (hasPersistentStore()) {
    await database.assertMigrationsApplied();
    return database.withTransaction(async () => {
      const pool = database.getPool();
      await pool.query('SELECT pg_advisory_xact_lock($1)', [PRESALE_LOCK_ID]);
      const existingResult = await pool.query(
        `SELECT signature, quote_id, wallet_address, payment_method, payment_atomic,
                usd_micros, token_micros, stage_id, confirmed_at
         FROM ${TABLE_NAME} WHERE signature = $1`,
        [record.signature],
      );
      if (existingResult.rowCount === 1) {
        return { inserted: false, record: normalizeRecord(existingResult.rows[0]) };
      }
      const quoteResult = await pool.query(
        `SELECT quote_id, wallet_address, payment_atomic, usd_micros, token_micros,
                stage_id, expires_at, consumed_signature
         FROM ${QUOTES_TABLE_NAME} WHERE quote_id = $1 FOR UPDATE`,
        [record.quoteId],
      );
      if (quoteResult.rowCount !== 1) throw new Error('Quote was not issued by this presale server.');
      const quote = quoteResult.rows[0];
      assertQuoteMatchesRecord(quote, record);
      if (quote.consumed_signature) throw new Error('This quote has already been used.');

      const soldResult = await pool.query(
        `SELECT COALESCE(SUM(token_micros), 0) AS sold FROM ${TABLE_NAME} WHERE stage_id = $1`,
        [record.stageId],
      );
      if (BigInt(soldResult.rows[0].sold) + BigInt(record.tokenMicros) > BigInt(maxStageTokenMicros)) {
        throw new Error('The current stage sold out before this payment could be allocated.');
      }
      const inserted = await pool.query(
        `
          INSERT INTO ${TABLE_NAME}
            (signature, quote_id, wallet_address, payment_method, payment_atomic,
             usd_micros, token_micros, stage_id, confirmed_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING signature, quote_id, wallet_address, payment_method,
                    payment_atomic, usd_micros, token_micros, stage_id, confirmed_at
        `,
        [record.signature, record.quoteId, record.walletAddress, record.paymentMethod,
          record.paymentAtomic, record.usdMicros, record.tokenMicros, record.stageId,
          record.confirmedAt],
      );
      await pool.query(
        `UPDATE ${QUOTES_TABLE_NAME} SET consumed_signature = $1 WHERE quote_id = $2`,
        [record.signature, record.quoteId],
      );
      return { inserted: true, record: normalizeRecord(inserted.rows[0]) };
    });
  }

  return withFileLock(async () => {
    const state = await readFileState();
    const existing = state.records.find((item) => item.signature === record.signature);
    if (existing) return { inserted: false, record: existing };
    const quote = state.quotes.find((item) => item.quoteId === record.quoteId);
    if (!quote) throw new Error('Quote was not issued by this presale server.');
    assertQuoteMatchesRecord(quote, record);
    if (quote.consumedSignature) throw new Error('This quote has already been used.');
    const sold = state.records.filter((item) => item.stageId === record.stageId)
      .reduce((sum, item) => sum + BigInt(item.tokenMicros), 0n);
    if (sold + BigInt(record.tokenMicros) > BigInt(maxStageTokenMicros)) {
      throw new Error('The current stage sold out before this payment could be allocated.');
    }
    const normalized = normalizeRecord(record);
    state.records.push(normalized);
    quote.consumedSignature = record.signature;
    await writeFileState(state);
    return { inserted: true, record: normalized };
  });
}

async function readFileState() {
  try {
    const value = JSON.parse(await fs.readFile(getDataFile(), 'utf8'));
    return {
      records: Array.isArray(value.records) ? value.records.map(normalizeRecord) : [],
      quotes: Array.isArray(value.quotes) ? value.quotes : [],
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { records: [], quotes: [] };
    throw error;
  }
}

async function writeFileState(state) {
  const filePath = getDataFile();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ version: 2, ...state }, null, 2));
  await fs.rename(temporary, filePath);
}

function withFileLock(operation) {
  const next = fileOperation.then(operation, operation);
  fileOperation = next.then(() => undefined, () => undefined);
  return next;
}

function assertQuoteMatchesRecord(quote, record) {
  const fields = [
    ['wallet_address', 'walletAddress'],
    ['payment_atomic', 'paymentAtomic'],
    ['usd_micros', 'usdMicros'],
    ['token_micros', 'tokenMicros'],
    ['stage_id', 'stageId'],
  ];
  for (const [databaseField, recordField] of fields) {
    const quoteValue = quote[databaseField] ?? quote[recordField];
    if (String(quoteValue) !== String(record[recordField])) {
      throw new Error('Quote details do not match the issued reservation.');
    }
  }
}

function normalizeRecord(record) {
  return {
    signature: String(record.signature),
    quoteId: String(record.quoteId ?? record.quote_id),
    walletAddress: String(record.walletAddress ?? record.wallet_address),
    paymentMethod: String(record.paymentMethod ?? record.payment_method),
    paymentAtomic: String(record.paymentAtomic ?? record.payment_atomic),
    usdMicros: String(record.usdMicros ?? record.usd_micros),
    tokenMicros: String(record.tokenMicros ?? record.token_micros),
    stageId: Number(record.stageId ?? record.stage_id),
    confirmedAt: new Date(record.confirmedAt ?? record.confirmed_at).toISOString(),
  };
}

module.exports = {
  consumeQuoteAndRecordAllocation,
  findBySignature,
  listAllocations,
  reserveQuote,
};
