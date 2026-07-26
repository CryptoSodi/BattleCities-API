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
const migrationLockName = 'battlecities_schema_migrations';

try {
  await database.withClient(async (client) => {
    // Multiple Vercel builds can overlap. A session-level advisory lock ensures
    // only one deployment can inspect or mutate the schema at a time.
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [
      migrationLockName,
    ]);

    try {
      await client.query(`
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
        const applied = await client.query(
          'SELECT 1 FROM battlecity_schema_migrations WHERE version = $1',
          [version],
        );
        if (applied.rowCount > 0) {
          continue;
        }

        const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(
            'INSERT INTO battlecity_schema_migrations (version) VALUES ($1)',
            [version],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
        console.log(`[battlecities-api] applied migration ${version}`);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [
        migrationLockName,
      ]);
    }
  });
} finally {
  await database.closePool();
}
