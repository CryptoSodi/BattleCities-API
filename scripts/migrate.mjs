import fs from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { loadLocalEnv } = require('../src/config/loadLocalEnv');

loadLocalEnv();

const database = require('../src/database');
const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

await database.getPool().query(`
  CREATE TABLE IF NOT EXISTS battlecity_schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);

const files = (await fs.readdir(migrationsDir))
  .filter((file) => /^\d+_[a-z0-9_-]+\.sql$/.test(file))
  .sort();

for (const file of files) {
  const version = file.replace(/\.sql$/, '');
  const applied = await database.getPool().query(
    'SELECT 1 FROM battlecity_schema_migrations WHERE version = $1',
    [version],
  );
  if (applied.rowCount > 0) {
    continue;
  }

  const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
  await database.withTransaction(async () => {
    await database.getPool().query(sql);
    await database.getPool().query(
      'INSERT INTO battlecity_schema_migrations (version) VALUES ($1)',
      [version],
    );
  });
  console.log(`[battlecities-api] applied migration ${version}`);
}

await database.closePool();
