import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { loadLocalEnv } = require('../src/config/loadLocalEnv');

loadLocalEnv();

const database = require('../src/database');
const storageConfig = require('../src/config/storageConfig');
if (!storageConfig.hasDatabaseConfig()) {
  throw new Error('Database check requires DATABASE_URL');
}
await database.assertStartupReady();
console.log('[battlecities-api] database is ready');
await database.closePool();
