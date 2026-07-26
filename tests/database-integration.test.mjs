import assert from 'assert/strict';
import { createRequire } from 'module';
import test from 'node:test';

const testDatabaseUrl = process.env.BATTLECITY_TEST_DATABASE_URL;

test(
  'configured test database has the latest migration and is reachable',
  { skip: !testDatabaseUrl },
  async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.BATTLECITY_STORAGE_MODE = 'postgres';

    const require = createRequire(import.meta.url);
    const database = require('../src/database');
    await database.assertStartupReady();
    const result = await database.getReadiness();
    assert.deepEqual(result, {
      ready: true,
      storage: 'postgres',
      migration: database.REQUIRED_MIGRATION,
    });
    await database.closePool();
  },
);
