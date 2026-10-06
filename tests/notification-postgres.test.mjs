import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const testDatabaseUrl = process.env.BATTLECITY_TEST_DATABASE_URL;

test('PostgreSQL registration handles ownership, permissions and precise conditional invalid-token cleanup',
  { skip: !testDatabaseUrl }, async () => {
    const previous = { ...process.env };
    process.env.NODE_ENV = 'test'; process.env.BATTLECITY_STORAGE_MODE = 'postgres';
    process.env.DATABASE_URL = testDatabaseUrl;
    delete process.env.BATTLECITY_FORCE_LOCAL_STORE;
    const database = require('../src/database');
    const players = require('../src/stores/playerStore');
    const devices = require('../src/stores/pushDeviceStore');
    const rollback = new Error('Rollback isolated notification fixture');
    const token = `test-postgres-device-${crypto.randomUUID()}`;
    const input = { token, platform: 'android', permission: 'granted' };
    try {
      await database.assertStartupReady();
      await assert.rejects(database.withTransaction(async () => {
        const player = await players.createGuestPlayer();
        await devices.upsertDevice(player.id, input);
        assert.equal((await devices.getGrantedDevice(token)).playerId, player.id);
        await devices.upsertDevice(null, input);
        assert.equal((await devices.listGrantedDevices(player.id)).length, 0);
        assert.equal((await devices.getGrantedDevice(token)).playerId, null);
        await devices.upsertDevice(player.id, { ...input, permission: 'denied' });
        assert.equal(await devices.getGrantedDevice(token), null);
        await devices.upsertDevice(player.id, input);
        // PostgreSQL stores microseconds. A JS Date must not truncate the cleanup guard.
        await database.getPool().query(
          "UPDATE battlecity_push_devices SET last_seen_at = '2026-10-06T12:00:00.123456Z' WHERE token = $1", [token],
        );
        const precise = await devices.getGrantedDevice(token);
        assert.equal(await devices.removeInvalidDevice(token, precise.lastSeenAt), true);
        await devices.upsertDevice(player.id, input);
        const old = await devices.getGrantedDevice(token);
        await devices.upsertDevice(null, input);
        assert.equal(await devices.removeInvalidDevice(token, old.lastSeenAt), false);
        assert.equal((await devices.getGrantedDevice(token)).playerId, null);
        const current = await devices.getGrantedDevice(token);
        assert.equal(await devices.removeInvalidDevice(token, current.lastSeenAt), true);
        assert.equal(await devices.getGrantedDevice(token), null);
        throw rollback;
      }), (error) => error === rollback);
    } finally {
      await database.closePool();
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  });
