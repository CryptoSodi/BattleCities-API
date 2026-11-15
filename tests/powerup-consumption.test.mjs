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

  const stocked = JSON.parse(await fs.readFile(accountPath, 'utf8'));
  stocked.inventory['extra-life'] = 1;
  await fs.writeFile(accountPath, JSON.stringify(stocked));
  const equipped = await economy.upsertAccountForPlayer(player, {
    loadout: { 'active-three': 'extra-life' },
  });
  assert.equal(equipped.loadout['active-three'], 'extra-life');
  const life = await economy.consumePowerupForPlayer(player, 'extra-life', 'life', 'powerup:test-extra-life');
  assert.equal(life.ok, true);
  assert.equal(life.powerupType, 'life');
  assert.equal(life.remaining, 0);
  assert.equal(life.account.loadout['active-three'], undefined);
  const lifeRetry = await economy.consumePowerupForPlayer(player, 'extra-life', 'life', 'powerup:test-extra-life');
  assert.equal(lifeRetry.ok, true);
  assert.equal(lifeRetry.idempotent, true);
  assert.equal((await economy.readAccount(player.id)).inventory['extra-life'], 0);

  const roster = {
    shield: 'shield', 'base-defence': 'defence', freeze: 'freeze', speed: 'speed',
    upgrade: 'upgrade', 'zoom-out': 'zoomout', wipeout: 'wipeout', 'extra-life': 'life',
    'max-healer': 'healmax', 'health-healer': 'heal2',
    'rapid-shooter': 'rapid', 'rapid-shooter-long': 'rapidlong',
  };
  for (const [item, type] of Object.entries(roster)) {
    const current = JSON.parse(await fs.readFile(accountPath, 'utf8'));
    current.inventory[item] = 1;
    await fs.writeFile(accountPath, JSON.stringify(current));
    const saved = await economy.upsertAccountForPlayer(player, { loadout: { 'active-one': item } });
    assert.equal(saved.loadout['active-one'], item, `${item} saves to a slot`);
    const result = await economy.consumePowerupForPlayer(player, item, type, `powerup:roster-${item}`);
    assert.equal(result.ok, true, `${item} can be consumed`);
    assert.equal(result.powerupType, type, `${item} maps to its gameplay effect`);
    assert.equal(result.remaining, 0, `${item} decrements stock`);
    assert.equal(result.account.loadout['active-one'], undefined, `${item} clears when exhausted`);
  }
  const online = JSON.parse(await fs.readFile(accountPath, 'utf8'));
  online.inventory.shield = 1;
  await fs.writeFile(accountPath, JSON.stringify(online));
  const receipt = '62a27239-d5fa-4d28-830c-096a15135074';
  const match = 'ASIA-TEST01:1:1';
  assert.equal((await economy.consumePowerupForPlayer(player, 'shield', 'shield', receipt, match)).ok, true);
  assert.equal((await economy.redeemMultiplayerPowerup(player, 'shield', receipt, 'OTHER-MATCH:1:1')).ok, false);
  const [firstClaim, retryClaim] = await Promise.all([
    economy.redeemMultiplayerPowerup(player, 'shield', receipt, match),
    economy.redeemMultiplayerPowerup(player, 'shield', receipt, match),
  ]);
  assert.equal(firstClaim.ok, true);
  assert.equal(retryClaim.ok, true);
  assert.notEqual(firstClaim.idempotent, retryClaim.idempotent);
  assert.equal((await economy.redeemMultiplayerPowerup(player, 'speed', receipt, match)).ok, false);
  assert.equal((await economy.consumePowerupForPlayer(player, 'shield', 'shield', receipt, 'OTHER-MATCH:1:1')).ok, false);
  assert.equal((await economy.refundMultiplayerPowerup(player, 'shield', receipt, match)).statusText, 'ALREADY ACTIVATED');
  const restocked = JSON.parse(await fs.readFile(accountPath, 'utf8'));
  restocked.inventory.shield=1;await fs.writeFile(accountPath,JSON.stringify(restocked));
  const refundable='b4716d16-0a98-4c04-a936-e24e4c90fb83';
  assert.equal((await economy.consumePowerupForPlayer(player,'shield','shield',refundable,match)).ok,true);
  const refund=await economy.refundMultiplayerPowerup(player,'shield',refundable,match);
  assert.equal(refund.ok,true);assert.equal(refund.account.inventory.shield,1);
  assert.equal((await economy.refundMultiplayerPowerup(player,'shield',refundable,match)).idempotent,true);
  assert.equal((await economy.redeemMultiplayerPowerup(player,'shield',refundable,match)).ok,false);
  const competing=JSON.parse(await fs.readFile(accountPath,'utf8'));
  competing.inventory.shield=1;await fs.writeFile(accountPath,JSON.stringify(competing));
  const race='c20d742d-60f9-4667-9e14-f1f634cfc955';
  assert.equal((await economy.consumePowerupForPlayer(player,'shield','shield',race,match)).ok,true);
  const [activation,refundRace]=await Promise.all([
    economy.redeemMultiplayerPowerup(player,'shield',race,match),
    economy.refundMultiplayerPowerup(player,'shield',race,match),
  ]);
  assert.notEqual(activation.ok,refundRace.ok,'activation and refund cannot both succeed');
});
