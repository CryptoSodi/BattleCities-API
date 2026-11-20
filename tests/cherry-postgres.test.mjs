import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const testDatabaseUrl = process.env.BATTLECITY_TEST_DATABASE_URL;

test('PostgreSQL stores Cherry sessions independently of wallet accounts', { skip: !testDatabaseUrl }, async () => {
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.BATTLECITY_STORAGE_MODE = 'postgres';
  process.env.NODE_ENV = 'test';
  const database = require('../dist/src/database');
  const sessions = require('../dist/src/stores/sessionStore');
  const players = require('../dist/src/stores/playerStore');
  const economy = require('../dist/src/stores/economyStore');
  const { Keypair } = require('@solana/web3.js');
  const wallet = Keypair.generate().publicKey.toBase58();
  const wallet2 = Keypair.generate().publicKey.toBase58();
  const cherryId = `postgres-test-${crypto.randomUUID()}`;
  const playerIds = new Set();
  try {
    await database.assertStartupReady();
    const ordinary = await sessions.createWalletSession(wallet);
    playerIds.add(ordinary.playerId);
    const ordinaryPlayer = await players.readPlayerForSession(ordinary);
    await economy.ensureAccountForPlayer(ordinaryPlayer);

    const first = await sessions.createCherrySession(cherryId, wallet, 'Cherry test');
    playerIds.add(first.playerId);
    assert.notEqual(first.playerId, ordinary.playerId);
    const restored = await sessions.readSession(first.id);
    assert.equal(restored.provider, 'cherry');
    assert.equal(restored.walletAddress, wallet);
    const cherryPlayer = await players.readPlayerForSession(restored);
    assert.equal(cherryPlayer.walletAddress, wallet);
    await economy.ensureAccountForPlayer(cherryPlayer);

    const second = await sessions.createCherrySession(cherryId, wallet2, 'Cherry test');
    assert.equal(second.playerId, first.playerId);
    const account = await economy.ensureAccountForPlayer(await players.readPlayerForSession(second));
    assert.equal(account.walletAddress, null);
    assert.equal((await economy.ensureAccountForPlayer(ordinaryPlayer)).walletAddress, wallet);
  } finally {
    for (const playerId of playerIds) {
      for (const table of ['battlecity_ledger_entries', 'battlecity_sessions', 'battlecity_economy_accounts'])
        await database.getPool().query(`DELETE FROM ${table} WHERE player_id=$1`, [playerId]);
      await database.getPool().query('DELETE FROM battlecity_players WHERE id=$1', [playerId]);
    }
    await database.closePool();
  }
});
