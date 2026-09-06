const fs = require('fs').promises;
const path = require('path');
const database = require('../database');
const storageConfig = require('../config/storageConfig');

const TABLE_NAME = 'battlecity_shop_payments';
let fileOperation = Promise.resolve();

function getDataFile() {
  return process.env.BATTLECITY_SHOP_PAYMENTS_FILE
    || path.join(process.cwd(), 'server-data', 'economy', 'shop-payments.json');
}

async function consumePayment(record, grant) {
  if (storageConfig.hasDatabaseConfig()) {
    await database.assertMigrationsApplied();
    return database.withTransaction(async () => {
      const pool = database.getPool();
      const existing = await pool.query(
        `SELECT signature, quote_id, player_id FROM ${TABLE_NAME}
         WHERE signature = $1 OR quote_id = $2
         FOR UPDATE`,
        [record.signature, record.quoteId],
      );
      if (existing.rowCount > 0) {
        const payment = existing.rows[0];
        if (payment.player_id !== record.playerId
          || payment.quote_id !== record.quoteId
          || payment.signature !== record.signature) {
          throw new Error('This payment or quote has already been used.');
        }
        return { inserted: false, account: await grant(false) };
      }

      await pool.query(
        `INSERT INTO ${TABLE_NAME}
          (signature, quote_id, player_id, wallet_address, item_id, currency,
           amount_atomic, confirmed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [record.signature, record.quoteId, record.playerId, record.walletAddress,
          record.itemId, record.currency, record.amountAtomic, record.confirmedAt],
      );
      return { inserted: true, account: await grant(true) };
    });
  }

  return withFileLock(async () => {
    const records = await readRecords();
    const existing = records.find((item) => (
      item.signature === record.signature || item.quoteId === record.quoteId
    ));
    if (existing) {
      if (existing.playerId !== record.playerId
        || existing.quoteId !== record.quoteId
        || existing.signature !== record.signature) {
        throw new Error('This payment or quote has already been used.');
      }
      return { inserted: false, account: await grant(false) };
    }
    const account = await grant(true);
    records.push(record);
    await writeRecords(records);
    return { inserted: true, account };
  });
}

async function readRecords() {
  try {
    const parsed = JSON.parse(await fs.readFile(getDataFile(), 'utf8'));
    return Array.isArray(parsed.records) ? parsed.records : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeRecords(records) {
  const filePath = getDataFile();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ version: 1, records }, null, 2));
  await fs.rename(temporary, filePath);
}

function withFileLock(operation) {
  const next = fileOperation.then(operation, operation);
  fileOperation = next.then(() => undefined, () => undefined);
  return next;
}

module.exports = { consumePayment };
