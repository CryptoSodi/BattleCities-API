import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseRequest, assertMigrationState, activateRelease } from '../scripts/oracle/deploy-shared.mjs';

test('deployment SSH entry rejects shell commands, extra arguments and injection', () => {
  const commit = 'a'.repeat(40), checksum = 'b'.repeat(64);
  assert.deepEqual(parseRequest(`deploy ${commit} ${checksum}`), { action: 'deploy', commit, checksum });
  assert.deepEqual(parseRequest('status'), { action: 'status' });
  for (const command of ['bash', 'status; whoami', `deploy ${commit} ${checksum}; id`, `deploy ${commit} ${checksum} extra`, `deploy ${'x'.repeat(40)} ${checksum}`, `deploy ${commit} ${checksum}\n`]) assert.throws(() => parseRequest(command));
});

test('automatic deployment blocks pending, removed and rewritten migrations', () => {
  const files = { '001_initial': 'original', '031_guest_wallet_auth': 'unchanged' };
  assert.doesNotThrow(() => assertMigrationState(Object.keys(files), files, { ...files }));
  assert.throws(() => assertMigrationState(Object.keys(files), files, { ...files, '032_destructive_change': 'new' }), /separate reviewed rollout/);
  assert.throws(() => assertMigrationState(Object.keys(files), files, { '031_guest_wallet_auth': 'unchanged' }), /separate reviewed rollout/);
  assert.throws(() => assertMigrationState(Object.keys(files), files, { ...files, '001_initial': 'rewritten' }), /applied migration was changed/);
});

async function fixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'battlecities-deploy-test-'));
  const previous = path.join(root, 'releases', 'old'), next = path.join(root, 'releases', 'next'), pointer = path.join(root, 'current');
  fs.mkdirSync(previous, { recursive: true }); fs.mkdirSync(next); fs.symlinkSync(previous, pointer, 'junction');
  try { await callback({ root, previous, next, pointer }); }
  finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('battlecities-deploy-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('failed new release health restores and restarts the previous API', { skip: process.platform === 'win32' }, () => fixture(async ({ previous, next, pointer }) => {
  let restarts = 0;
  await assert.rejects(activateRelease({ pointer, release: next, restart: async () => { restarts += 1; }, ready: async () => fs.realpathSync(pointer) === previous }), /Previous API restored/);
  assert.equal(fs.realpathSync(pointer), previous);
  assert.equal(restarts, 2);
}));

test('a successful release is activated without restarting the previous version', { skip: process.platform === 'win32' }, () => fixture(async ({ previous, next, pointer }) => {
  let restarts = 0;
  assert.equal(await activateRelease({ pointer, release: next, restart: async () => { restarts += 1; }, ready: async () => true }), previous);
  assert.equal(fs.realpathSync(pointer), next); assert.equal(restarts, 1);
}));

test('failed rollback reports a concrete recovery need and restores the previous pointer', { skip: process.platform === 'win32' }, () => fixture(async ({ previous, next, pointer }) => {
  await assert.rejects(activateRelease({ pointer, release: next, restart: async () => {}, ready: async () => false }), /Rollback needs administrator attention/);
  assert.equal(fs.realpathSync(pointer), previous);
}));
