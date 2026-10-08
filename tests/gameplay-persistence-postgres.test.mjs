import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const testDatabaseUrl = process.env.BATTLECITY_TEST_DATABASE_URL;

test('PostgreSQL fuel debit and receipt are atomic across retries, simultaneous starts and account reads', { skip: !testDatabaseUrl }, async () => {
  process.env.DATABASE_URL = testDatabaseUrl; process.env.BATTLECITY_STORAGE_MODE = 'postgres'; process.env.NODE_ENV = 'test';
  const database = require('../dist/src/database');
  const economy = require('../dist/src/stores/economyStore');
  const ledger = require('../dist/src/stores/ledgerStore');
  const players = require('../dist/src/stores/playerStore');
  const matches = require('../dist/src/stores/matchResultStore');
  const seasons = require('../dist/src/stores/seasonStore');
  let player;
  try {
    await database.assertStartupReady();
    player = await players.createGuestPlayer();
    const requestId = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 8 }, () => economy.consumeFuelForPlayer(player, requestId, 0)));
    assert.equal(results.filter(r => !r.idempotent).length, 1);
    assert.ok(results.every(r => r.ok && r.account.fuelBalance === 4));
    assert.equal((await economy.consumeFuelForPlayer(player, requestId, 1)).status, 409);
    const starts = await Promise.all(Array.from({ length: 8 }, async () => {
      const [result] = await Promise.all([economy.consumeFuelForPlayer(player, crypto.randomUUID(), 0), economy.ensureAccountForPlayer(player)]);
      return result;
    }));
    assert.equal(starts.filter(r => r.ok).length, 4);
    assert.equal((await economy.readAccount(player.id)).fuelBalance, 0);
    assert.equal((await ledger.listEntriesForPlayer(player.id)).length, 5);
    await economy.creditFuel(player, 2);
    const append = ledger.appendEntries;
    ledger.appendEntries = async () => { throw new Error('Receipt unavailable'); };
    try { await assert.rejects(economy.consumeFuelForPlayer(player, crypto.randomUUID(), 0), /Receipt unavailable/); }
    finally { ledger.appendEntries = append; }
    assert.equal((await economy.readAccount(player.id)).fuelBalance, 2);
    const season = await seasons.getCurrentSeason();
    await Promise.all([2500, 500, 1000].map(score => matches.submitResult(player, season, { score, levelNumber: 1, won: false })));
    assert.equal((await players.readPlayer(player.id)).highscorePrimary, 2500);
  } finally {
    if (player) {
      for (const table of ['battlecity_match_results', 'battlecity_ledger_entries', 'battlecity_economy_accounts']) await database.getPool().query(`DELETE FROM ${table} WHERE player_id=$1`, [player.id]);
      await database.getPool().query('DELETE FROM battlecity_players WHERE id=$1', [player.id]);
    }
    await database.closePool();
  }
});
