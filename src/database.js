const { AsyncLocalStorage } = require('async_hooks');
const storageConfig = require('./config/storageConfig');

const REQUIRED_MIGRATION = '008_discord_verification';
const transactionStorage = new AsyncLocalStorage();

let pool = null;
let migrationCheck = null;

function createPool() {
  const { Pool } = require('pg');
  const createdPool = new Pool({
    connectionString: storageConfig.getDatabaseUrl(),
    max: parsePositiveInteger(process.env.BATTLECITY_DATABASE_POOL_SIZE, 10),
    idleTimeoutMillis: parsePositiveInteger(
      process.env.BATTLECITY_DATABASE_IDLE_TIMEOUT_MS,
      30000,
    ),
    connectionTimeoutMillis: parsePositiveInteger(
      process.env.BATTLECITY_DATABASE_CONNECT_TIMEOUT_MS,
      5000,
    ),
    ssl: resolveSslConfig(),
  });
  createdPool.on('error', (error) => {
    console.error('[battlecities-api] idle database client failed', error);
  });
  return createdPool;
}

function getRawPool() {
  if (!storageConfig.hasDatabaseConfig()) {
    throw new Error('PostgreSQL is not configured');
  }
  if (pool === null) {
    pool = createPool();
  }
  return pool;
}

function getPool() {
  return {
    query(text, values) {
      const client = transactionStorage.getStore();
      return (client || getRawPool()).query(text, values);
    },
  };
}

async function withClient(operation) {
  const client = await getRawPool().connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

async function withTransaction(operation) {
  if (!storageConfig.hasDatabaseConfig() || transactionStorage.getStore()) {
    return operation();
  }

  const client = await getRawPool().connect();
  try {
    await client.query('BEGIN');
    const result = await transactionStorage.run(client, operation);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[battlecities-api] database rollback failed', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

async function assertMigrationsApplied() {
  if (!storageConfig.hasDatabaseConfig()) {
    return;
  }
  if (migrationCheck === null) {
    migrationCheck = verifyMigrations().catch((error) => {
      migrationCheck = null;
      throw error;
    });
  }
  return migrationCheck;
}

async function verifyMigrations() {
  let result;
  try {
    result = await getRawPool().query(
      `SELECT version FROM battlecity_schema_migrations WHERE version = $1`,
      [REQUIRED_MIGRATION],
    );
  } catch (error) {
    if (error?.code === '42P01') {
      throw new Error('Database is not migrated; run npm run db:migrate');
    }
    throw error;
  }
  if (result.rowCount !== 1) {
    throw new Error(
      `Database migration ${REQUIRED_MIGRATION} is required; run npm run db:migrate`,
    );
  }
}

async function assertStartupReady() {
  storageConfig.assertStorageModeAllowed();
  if (storageConfig.hasDatabaseConfig()) {
    await assertMigrationsApplied();
    await getRawPool().query('SELECT 1');
  }
}

async function getReadiness() {
  storageConfig.assertStorageModeAllowed();
  if (!storageConfig.hasDatabaseConfig()) {
    return { ready: true, storage: 'local' };
  }

  await assertMigrationsApplied();
  await getRawPool().query('SELECT 1');
  return {
    ready: true,
    storage: 'postgres',
    migration: REQUIRED_MIGRATION,
  };
}

async function closePool() {
  if (pool !== null) {
    const current = pool;
    pool = null;
    migrationCheck = null;
    await current.end();
  }
}

function resolveSslConfig() {
  const mode = String(process.env.BATTLECITY_DATABASE_SSL || '').toLowerCase();
  if (mode === 'disable') {
    return false;
  }
  if (mode === 'verify-full') {
    return { rejectUnauthorized: true };
  }
  if (mode === 'require' || storageConfig.isProductionRuntime()) {
    return { rejectUnauthorized: false };
  }
  return false;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = {
  REQUIRED_MIGRATION,
  assertMigrationsApplied,
  assertStartupReady,
  closePool,
  getPool,
  getReadiness,
  withClient,
  withTransaction,
};
