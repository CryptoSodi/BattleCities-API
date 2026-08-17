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

test('match archive migration persists metadata and ordered frame batches', async () => {
  const sql = await fs.readFile(
    path.join(packageRoot, 'migrations/005_match_archives.sql'),
    'utf8',
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS battlecity_match_archives\b/);
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS battlecity_match_archive_batches\b/,
  );
  assert.match(sql, /simulation_config_json JSONB NOT NULL/);
  assert.match(sql, /players_json JSONB NOT NULL/);
  assert.match(sql, /frames_json JSONB NOT NULL/);
  assert.match(sql, /PRIMARY KEY \(match_id, start_seq\)/);
  assert.match(sql, /jsonb_array_length\(frames_json\) = frame_count/);
});

test('admin tournament migration supports audited idempotent prize payouts', async () => {
  const sql = await fs.readFile(
    path.join(packageRoot, 'migrations/009_admin_tournaments.sql'),
    'utf8',
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS battlecity_tournaments\b/);
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS battlecity_tournament_prize_distributions\b/,
  );
  assert.match(sql, /UNIQUE \(tournament_id, player_id\)/);
  assert.match(sql, /prizes_distributed_at TIMESTAMPTZ NULL/);
  assert.match(sql, /CHECK \(prize_pool >= 0\)/);
});

test('headless target migration constrains persisted runtime selection', async () => {
  const sql = await fs.readFile(
    path.join(packageRoot, 'migrations/010_headless_target.sql'),
    'utf8',
  );
  assert.match(sql, /ADD COLUMN IF NOT EXISTS headless_target TEXT NULL/);
  assert.match(sql, /'worker', 'bom1', 'usa'/);
  const removalSql = await fs.readFile(
    path.join(packageRoot, 'migrations/011_remove_usa_headless_target.sql'),
    'utf8',
  );
  assert.match(removalSql, /SET headless_target = 'worker'/);
  assert.match(removalSql, /'worker', 'bom1'/);
});

test('presence migration stores fresh online and in-game state per player', async () => {
  const sql = await fs.readFile(
    path.join(packageRoot, 'migrations/015_player_presence.sql'),
    'utf8',
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS battlecity_player_presence\b/);
  assert.match(sql, /player_id TEXT PRIMARY KEY REFERENCES battlecity_players\(id\)/);
  assert.match(sql, /in_game BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(sql, /last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
});

test('site presence migration supports anonymous visitors and multiple tabs', async () => {
  const sql = await fs.readFile(
    path.join(packageRoot, 'migrations/016_site_visitor_presence.sql'),
    'utf8',
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS battlecity_site_presence\b/);
  assert.match(sql, /PRIMARY KEY \(visitor_id, client_id\)/);
  assert.match(sql, /player_id TEXT REFERENCES battlecity_players\(id\) ON DELETE SET NULL/);
  assert.match(sql, /DROP TABLE battlecity_player_presence/);
});

test('presale migration records verified allocations idempotently', async () => {
  const sql = await fs.readFile(
    path.join(packageRoot, 'migrations/017_presale_allocations.sql'),
    'utf8',
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS battlecity_presale_allocations\b/);
  assert.match(sql, /signature TEXT PRIMARY KEY/);
  assert.match(sql, /quote_id TEXT NOT NULL UNIQUE/);
  assert.match(sql, /payment_method IN \('SOL'\)/);
  assert.match(sql, /stage_id BETWEEN 1 AND 3/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS battlecity_presale_quotes\b/);
  assert.match(sql, /consumed_signature TEXT UNIQUE/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS battlecity_presale_allocations_stage_id_idx/);
});

test('presale delivery migration makes Token-2022 delivery traceable and retryable', async () => {
  const sql = await fs.readFile(
    path.join(packageRoot, 'migrations/018_presale_token_delivery.sql'),
    'utf8',
  );
  assert.match(sql, /delivery_status TEXT NOT NULL DEFAULT 'pending'/);
  assert.match(sql, /delivery_transaction_signature TEXT/);
  assert.match(sql, /delivery_attempts INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /delivery_failure_reason TEXT/);
  assert.match(sql, /delivery_raw_transaction TEXT/);
  assert.match(sql, /delivery_status IN \('pending', 'sending', 'delivered', 'failed'\)/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS battlecity_presale_allocations_delivery_signature_idx/);
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
