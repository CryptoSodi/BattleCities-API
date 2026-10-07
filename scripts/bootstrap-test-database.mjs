import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export function assertTestDatabaseTarget(environment) {
  const url = new URL(environment.DATABASE_URL || 'postgresql://invalid');
  const name = decodeURIComponent(url.pathname.slice(1));
  if (environment.NODE_ENV !== 'test' || !['127.0.0.1', 'localhost'].includes(url.hostname) || !/^[a-z0-9_]+_(test|ci)$/.test(name)) {
    throw new Error('Database bootstrap is restricted to an explicitly configured local test database.');
  }
  return url.toString();
}

export async function bootstrapTestDatabase(environment = process.env) {
  const connectionString = assertTestDatabaseTarget(environment);
  const require = createRequire(import.meta.url);
  const { Client } = require('pg');
  const client = new Client({ connectionString, ssl: false });
  await client.connect();
  try {
    const existing = await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    if (existing.rowCount !== 0) throw new Error('Refusing to bootstrap a database containing existing tables.');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const schema = await fs.readFile(path.join(root, 'tests/fixtures/postgres-baseline.sql'), 'utf8');
    const baseline = JSON.parse(await fs.readFile(path.join(root, 'tests/fixtures/postgres-baseline.json'), 'utf8'));
    await client.query('BEGIN');
    try {
      await client.query(schema);
      for (const version of baseline.versions) await client.query('INSERT INTO public.battlecity_schema_migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    console.log(`[battlecities-api] isolated test schema initialized at ${baseline.migration}`);
  } finally { await client.end(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await bootstrapTestDatabase();
