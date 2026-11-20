import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import playerStore from '../src/stores/playerStore.js';
import sessionStore from '../src/stores/sessionStore.js';

test('Cherry player identity is stable across launches and independent of wallets', async () => {
  process.env.BATTLECITY_PLAYER_DIR = await mkdtemp(path.join(os.tmpdir(), 'battlecities-cherry-player-'));
  process.env.BATTLECITY_SESSION_DIR = await mkdtemp(path.join(os.tmpdir(), 'battlecities-cherry-session-'));
  const [a, b] = await Promise.all([
    playerStore.findOrCreateCherryPlayer('cherry-user-1', 'Commander'),
    playerStore.findOrCreateCherryPlayer('cherry-user-1', 'Commander'),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(a.walletAddress, null);
  assert.equal((await playerStore.readPlayer(a.id)).displayName, 'Commander');
  assert.notEqual((await playerStore.findOrCreateCherryPlayer('cherry-user-2', 'Commander')).id, a.id);
  const first = await sessionStore.createCherrySession('cherry-user-1', '11111111111111111111111111111111', 'Commander');
  const second = await sessionStore.createCherrySession('cherry-user-1', '22222222222222222222222222222222', 'Commander');
  assert.equal(first.playerId, a.id);
  assert.equal(second.playerId, a.id);
  assert.notEqual(first.walletAddress, second.walletAddress);
  assert.equal((await sessionStore.readSession(first.id)).provider, 'cherry');
  assert.equal((await sessionStore.readSession(second.id)).walletAddress, second.walletAddress);
  await assert.rejects(playerStore.findOrCreateCherryPlayer('', 'Commander'));
});
