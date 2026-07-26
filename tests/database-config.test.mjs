import assert from 'assert/strict';
import { createRequire } from 'module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const storageConfig = require('../src/config/storageConfig');

const ENV_KEYS = [
  'NODE_ENV',
  'VERCEL_ENV',
  'DATABASE_URL',
  'POSTGRES_URL',
  'POSTGRES_PRISMA_URL',
  'POSTGRES_URL_NON_POOLING',
  'BATTLECITY_STORAGE_MODE',
  'BATTLECITY_FORCE_LOCAL_STORE',
];

test('development may explicitly use local JSON storage', () => {
  withEnvironment(
    { NODE_ENV: 'development', BATTLECITY_STORAGE_MODE: 'local' },
    () => {
      assert.equal(storageConfig.hasDatabaseConfig(), false);
      assert.equal(storageConfig.isLocalStorageForced(), true);
    },
  );
});

test('production requires a PostgreSQL URL', () => {
  withEnvironment({ NODE_ENV: 'production' }, () => {
    assert.throws(
      () => storageConfig.assertStorageModeAllowed(),
      /DATABASE_URL is required in production/,
    );
  });
});

test('production rejects forced local storage even with a database URL', () => {
  withEnvironment(
    {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://example.invalid/battlecity',
      BATTLECITY_STORAGE_MODE: 'local',
    },
    () => {
      assert.throws(
        () => storageConfig.assertStorageModeAllowed(),
        /Local JSON storage is disabled in production/,
      );
    },
  );
});

test('production replay storage requires blob configuration', async () => {
  await withEnvironmentAsync(
    {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://example.invalid/battlecity',
    },
    async () => {
      const replayStore = require('../src/stores/replayStore');
      assert.throws(
        () => replayStore.isPersistentStoreConfigured(),
        /BLOB_READ_WRITE_TOKEN is required in production/,
      );
    },
  );
});

function withEnvironment(values, operation) {
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  ENV_KEYS.forEach((key) => delete process.env[key]);
  Object.assign(process.env, values);
  try {
    operation();
  } finally {
    ENV_KEYS.forEach((key) => {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    });
  }
}

async function withEnvironmentAsync(values, operation) {
  const previous = Object.fromEntries(
    [...ENV_KEYS, 'BLOB_READ_WRITE_TOKEN'].map((key) => [key, process.env[key]]),
  );
  [...ENV_KEYS, 'BLOB_READ_WRITE_TOKEN'].forEach(
    (key) => delete process.env[key],
  );
  Object.assign(process.env, values);
  try {
    await operation();
  } finally {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  }
}
