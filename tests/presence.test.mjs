import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('presence counts unique active players and the in-game subset', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'battlecities-presence-'),
  );
  process.env.BATTLECITY_STORAGE_MODE = 'local';
  process.env.BATTLECITY_PRESENCE_FILE = path.join(directory, 'presence.json');

  const presenceStore = require('../src/stores/presenceStore.js');

  await presenceStore.recordPresence('ply-alpha', { inGame: false });
  await presenceStore.recordPresence('ply-bravo', {
    inGame: true,
    gameMode: 'single-player',
  });

  assert.deepEqual(await presenceStore.getCounts(), {
    online: 2,
    inGame: 1,
    windowSeconds: 90,
  });

  await presenceStore.recordPresence('ply-alpha', {
    inGame: true,
    gameMode: 'multiplayer',
  });
  assert.equal((await presenceStore.getCounts()).inGame, 2);

  await presenceStore.removePresence('ply-bravo');
  assert.deepEqual(await presenceStore.getCounts(), {
    online: 1,
    inGame: 1,
    windowSeconds: 90,
  });

  await fs.rm(directory, { recursive: true, force: true });
});

test('presence rejects invalid player identifiers', async () => {
  const presenceStore = require('../src/stores/presenceStore.js');
  await assert.rejects(
    () => presenceStore.recordPresence('guest-player', { inGame: true }),
    /Invalid player ID/,
  );
});
