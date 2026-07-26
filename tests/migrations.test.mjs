import assert from 'assert/strict';
import fs from 'fs/promises';
import path from 'path';
import test from 'node:test';
import { fileURLToPath } from 'url';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const expectedTables = [
  'battlecity_players',
  'battlecity_sessions',
  'battlecity_economy_accounts',
  'battlecity_ledger_entries',
  'battlecity_seasons',
  'battlecity_match_results',
  'battlecity_leaderboard_rows',
  'battlecity_replays',
  'battlecity_quest_progress',
  'battlecity_event_currency_balances',
  'battlecity_airdrop_state',
  'battlecity_staking_state',
  'battlecity_trading_volume',
  'battlecity_webrtc_signals',
  'battlecity_webrtc_observers',
  'battlecity_wallet_challenges',
];

test('initial migration owns every persistent table', async () => {
  const sql = await fs.readFile(
    path.join(packageRoot, 'migrations/001_initial.sql'),
    'utf8',
  );
  expectedTables.forEach((table) => {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  });
});

test('hardening migration contains indexes, foreign keys, and checks', async () => {
  const sql = await fs.readFile(
    path.join(packageRoot, 'migrations/002_constraints.sql'),
    'utf8',
  );
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS/);
  assert.match(sql, /FOREIGN KEY/);
  assert.match(sql, /CHECK \(/);
  assert.match(sql, /battlecity_webrtc_signal_route_check/);
});

test('multiplayer migration owns matchmaking, score, and prize tables', async () => {
  const sql = await fs.readFile(
    path.join(packageRoot, 'migrations/003_multiplayer.sql'),
    'utf8',
  );
  [
    'battlecity_multiplayer_matches',
    'battlecity_multiplayer_participants',
    'battlecity_multiplayer_event_entries',
    'battlecity_multiplayer_scores',
    'battlecity_event_prize_approvals',
  ].forEach((table) => {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  });
  assert.match(sql, /UNIQUE \(match_id, player_slot\)/);
  assert.match(sql, /fuel_refunded <= fuel_charged/);
});

test('broadcaster migration persists the worker lifecycle without exposing secrets', async () => {
  const sql = await fs.readFile(
    path.join(packageRoot, 'migrations/004_broadcaster_runtime.sql'),
    'utf8',
  );
  assert.match(sql, /broadcaster_status/);
  assert.match(sql, /broadcaster_started_at/);
  assert.match(sql, /broadcaster_worker_url/);
  assert.match(sql, /'starting', 'running', 'stopped', 'failed'/);
  assert.doesNotMatch(sql, /service_token/i);
});

test('stores use migrations and the shared pool instead of request-time DDL', async () => {
  const folders = ['stores', 'services'];
  for (const folder of folders) {
    const directory = path.join(packageRoot, 'src', folder);
    const files = (await fs.readdir(directory)).filter((file) => file.endsWith('.js'));
    for (const file of files) {
      const source = await fs.readFile(path.join(directory, file), 'utf8');
      assert.doesNotMatch(source, /new Pool\s*\(/, file);
      assert.doesNotMatch(source, /CREATE TABLE/i, file);
    }
  }
});

test('migration runner serializes concurrent deployments', async () => {
  const source = await fs.readFile(
    path.join(packageRoot, 'scripts/migrate.mjs'),
    'utf8',
  );
  assert.match(source, /pg_advisory_lock/);
  assert.match(source, /pg_advisory_unlock/);
  assert.match(source, /BEGIN/);
  assert.match(source, /ROLLBACK/);
});

test('Vercel runs migrations only for production deployments', async () => {
  const deploySource = await fs.readFile(
    path.join(packageRoot, 'scripts/migrate-deploy.mjs'),
    'utf8',
  );
  const packageJson = JSON.parse(
    await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'),
  );
  const vercelConfig = JSON.parse(
    await fs.readFile(path.join(packageRoot, 'vercel.json'), 'utf8'),
  );

  assert.match(deploySource, /VERCEL_ENV/);
  assert.match(deploySource, /environment === 'production'/);
  assert.equal(
    packageJson.scripts['deploy:migrate'],
    'node scripts/migrate-deploy.mjs',
  );
  assert.equal(vercelConfig.buildCommand, 'npm run deploy:migrate');
  assert.equal(vercelConfig.outputDirectory, 'public');
  await fs.access(path.join(packageRoot, 'public/robots.txt'));
});
