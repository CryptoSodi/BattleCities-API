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

test('referral rankings use distinct referred players and exact currency totals across pages', { skip: !testDatabaseUrl }, async () => {
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.BATTLECITY_STORAGE_MODE = 'postgres';
  const require = createRequire(import.meta.url);
  const database = require('../src/database');
  const { listReferrers } = require('../src/stores/adminStore');
  try {
    await database.withTransaction(async () => {
      const db = database.getPool();
      await db.query(`
        CREATE TEMP TABLE battlecity_players (LIKE public.battlecity_players INCLUDING DEFAULTS) ON COMMIT DROP;
        CREATE TEMP TABLE battlecity_referrals (LIKE public.battlecity_referrals INCLUDING DEFAULTS) ON COMMIT DROP;
        CREATE TEMP TABLE battlecity_referral_rewards (LIKE public.battlecity_referral_rewards INCLUDING DEFAULTS) ON COMMIT DROP;

        INSERT INTO battlecity_players (id, provider, display_name, wallet_address, created_at, updated_at, last_seen_at)
        SELECT id, 'wallet', upper(id), 'wallet-' || id, now(), now(), now()
        FROM unnest(ARRAY['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']) AS id;
        INSERT INTO battlecity_referrals (referrer_player_id, referred_player_id)
        VALUES ('alpha', 'bravo'), ('alpha', 'charlie'), ('alpha', 'delta'),
          ('bravo', 'echo'), ('charlie', 'foxtrot');
        INSERT INTO battlecity_referral_rewards (
          payment_signature, referrer_player_id, referred_player_id, currency, network, token_mint, token_program, decimals, amount_atomic
        ) VALUES ('one', 'alpha', 'bravo', 'sol', 'mainnet-beta', NULL, NULL, 9, 9007199254740993),
          ('two', 'alpha', 'bravo', 'sol', 'mainnet-beta', NULL, NULL, 9, 8),
          ('three', 'alpha', 'charlie', 'skr', 'mainnet-beta', 'skr-mint', 'token-program', 6, 25),
          ('four', 'bravo', 'echo', 'sol', 'mainnet-beta', NULL, NULL, 9, 1);
      `);

      const first = await listReferrers({ limit: 2 });
      assert.equal(first.hasMore, true);
      assert.deepEqual(first.items.map(({ playerId, rank, referredCount }) => [playerId, rank, referredCount]), [
        ['alpha', 1, 3], ['bravo', 2, 1],
      ]);
      assert.deepEqual(first.items[0].rewards.map(({ currency, amountAtomic, amount }) => [currency, amountAtomic, amount]), [
        ['skr', '25', '0.000025'], ['sol', '9007199254741001', '9007199.254741001'],
      ]);

      const last = await listReferrers({ limit: 2, offset: 2 });
      assert.equal(last.hasMore, false);
      assert.deepEqual(last.items, [{
        playerId: 'charlie', displayName: 'CHARLIE', walletAddress: 'wallet-charlie', rank: 2, referredCount: 1, rewards: [],
      }]);

      await db.query('TRUNCATE pg_temp.battlecity_referrals');
      assert.deepEqual(await listReferrers(), { items: [], limit: 50, offset: 0, hasMore: false });
    });
  } finally {
    await database.closePool();
  }
});
