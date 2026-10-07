import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { assertTestDatabaseTarget, bootstrapTestDatabase } from '../scripts/bootstrap-test-database.mjs';

test('schema fixture bootstrap rejects production, remote databases and non-test names', () => {
  const url = 'postgresql://postgres:password@127.0.0.1/battlecities_test';
  assert.equal(assertTestDatabaseTarget({ NODE_ENV: 'test', DATABASE_URL: url }), new URL(url).toString());
  for (const environment of [{ NODE_ENV: 'production', DATABASE_URL: url }, { NODE_ENV: 'test', DATABASE_URL: url.replace('battlecities_test', 'battlecities') }, { NODE_ENV: 'test', DATABASE_URL: url.replace('127.0.0.1', 'production.example.com') }, {}]) assert.throws(() => assertTestDatabaseTarget(environment), /restricted/);
});

test('schema fixture bootstrap leaves an existing database intact', { skip: !process.env.BATTLECITY_TEST_DATABASE_URL }, async () => {
  const require = createRequire(import.meta.url);
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.BATTLECITY_TEST_DATABASE_URL, ssl: false });
  await client.connect();
  try {
    const before = await client.query('SELECT count(*)::int AS count FROM battlecity_players');
    await assert.rejects(bootstrapTestDatabase({ NODE_ENV: 'test', DATABASE_URL: process.env.BATTLECITY_TEST_DATABASE_URL }), /restricted|existing tables/);
    assert.deepEqual((await client.query('SELECT count(*)::int AS count FROM battlecity_players')).rows, before.rows);
  } finally { await client.end(); }
});
