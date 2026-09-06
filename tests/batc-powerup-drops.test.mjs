import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const drops = require('../src/services/batcPowerupDrops');

test('BATC drops are safely disabled by default and locked to mainnet BATC', () => {
  const config = drops.readConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.network, 'mainnet-beta');
  assert.equal(
    config.tokenMint.toBase58(),
    'Hxs5gXuPHv3Jhm7PYQv9iFMQp5ZYL2Fk6bgWdvQz15bz',
  );
  assert.equal(config.chance100Bps, 25);
  assert.equal(config.chance200Bps, 5);
});

test('disabled BATC drops do not require a database or issue a claim', async () => {
  const result = await drops.roll({
    id: 'ply-test',
    provider: 'wallet',
    walletAddress: '7P5t1uh64Kxh524jz1EMDhQNsnd7DxZju5gfjRtqxYUM',
  }, '0123456789abcdef', 1);
  assert.equal(result, null);
});

test('BATC drop migration enforces one request and fixed reward amounts', async () => {
  const sql = await fs.readFile(
    new URL('../migrations/029_batc_powerup_drops.sql', import.meta.url),
    'utf8',
  );
  assert.match(sql, /UNIQUE \(player_id, request_id\)/);
  assert.match(sql, /amount IN \(0, 100, 200\)/);
  assert.match(sql, /delivery_raw_transaction/);
});
