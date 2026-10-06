import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);

test('powerup consumption is authoritative and idempotent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'battlecities-powerup-'));
  process.env.NODE_ENV = 'development';
  process.env.BATTLECITY_STORAGE_MODE = 'local';
  process.env.BATTLECITY_ECONOMY_DIR = path.join(root, 'economy');
  process.env.BATTLECITY_LEDGER_DIR = path.join(root, 'ledger');

  const economy = require('../src/stores/economyStore');
  const player = {
    id: 'ply-powerup-test',
    provider: 'guest',
    displayName: 'Powerup Test',
    walletAddress: null,
  };
  assert.equal(
    (await economy.ensureAccountForPlayer(player)).fuelBalance,
    5,
  );
  const accountPath = path.join(root, 'economy', `${player.id}.json`);
  const account = JSON.parse(await fs.readFile(accountPath, 'utf8'));
  account.inventory.shield = 1;
  await fs.writeFile(accountPath, JSON.stringify(account));

  const first = await economy.consumePowerupForPlayer(
    player,
    'shield',
    'shield',
    'powerup:test-consume-1',
  );
  assert.equal(first.ok, true);
  assert.equal(first.remaining, 0);

  const retry = await economy.consumePowerupForPlayer(
    player,
    'shield',
    'shield',
    'powerup:test-consume-1',
  );
  assert.equal(retry.ok, true);
  assert.equal(retry.idempotent, true);
  assert.equal((await economy.readAccount(player.id)).inventory.shield, 0);

  const forged = await economy.consumePowerupForPlayer(
    player,
    'shield',
    'speed',
    'powerup:test-consume-2',
  );
  assert.equal(forged.ok, false);
  assert.equal(forged.statusText, 'INVALID POWERUP');

  const empty = await economy.consumePowerupForPlayer(
    player,
    'shield',
    'shield',
    'powerup:test-consume-3',
  );
  assert.equal(empty.ok, false);
  assert.equal(empty.statusText, 'POWERUP NOT OWNED');
});
