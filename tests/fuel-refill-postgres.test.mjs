import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const testDatabaseUrl = process.env.BATTLECITY_TEST_DATABASE_URL;

test('PostgreSQL refill locks, ledger rollback, and purchased-fuel cap', { skip: !testDatabaseUrl }, async () => {
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.BATTLECITY_STORAGE_MODE = 'postgres'; process.env.NODE_ENV = 'test';
  const database = require('../dist/src/database');
  const economy = require('../dist/src/stores/economyStore');
  const ledger = require('../dist/src/stores/ledgerStore');
  const players = require('../dist/src/stores/playerStore');
  let player;
  try {
    await database.assertStartupReady();
    player = await players.createGuestPlayer();
    await economy.ensureAccountForPlayer(player);
    const age = () => database.getPool().query(`UPDATE battlecity_economy_accounts
      SET fuel_balance=0, fuel_refill_at=NOW()-INTERVAL '31 minutes' WHERE player_id=$1`, [player.id]);
    await age();
    const results = await Promise.all(Array.from({ length: 10 }, () => economy.consumeFuelForPlayer(player, crypto.randomUUID(), 0)));
    assert.equal(results.filter(r => r.ok).length, 5);
    const refills = (await ledger.listEntriesForPlayer(player.id)).filter(e => e.sourceType === 'fuel-refill');
    assert.equal(refills.length, 1); assert.equal(refills[0].amount, 5);
    await age();
    const before = await economy.readAccount(player.id);
    const append = ledger.appendEntries;
    ledger.appendEntries = async () => { throw new Error('Refill ledger unavailable'); };
    try { await assert.rejects(economy.ensureAccountForPlayer(player), /Refill ledger unavailable/); }
    finally { ledger.appendEntries = append; }
    const after = await economy.readAccount(player.id);
    assert.equal(after.fuelBalance, before.fuelBalance);
    assert.equal(after.fuelRefillAt, before.fuelRefillAt);
    await economy.ensureAccountForPlayer(player);
    await economy.creditFuel(player, 20);
    await database.getPool().query(`UPDATE battlecity_economy_accounts
      SET fuel_refill_at=NOW()-INTERVAL '3 hours' WHERE player_id=$1`, [player.id]);
    assert.equal((await economy.ensureAccountForPlayer(player)).fuelBalance, 25);
  } finally {
    if (player) {
      for (const table of ['battlecity_ledger_entries', 'battlecity_economy_accounts'])
        await database.getPool().query(`DELETE FROM ${table} WHERE player_id=$1`, [player.id]);
      await database.getPool().query('DELETE FROM battlecity_players WHERE id=$1', [player.id]);
    }
    await database.closePool();
  }
});
