import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('presence counts unique visitors and keeps in-game true across tabs', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'battlecities-presence-'),
  );
  process.env.BATTLECITY_STORAGE_MODE = 'local';
  process.env.BATTLECITY_PRESENCE_FILE = path.join(directory, 'presence.json');

  const presenceStore = require('../src/stores/presenceStore.js');

  const visitorOne = 'visitor-11111111111111111111111111111111';
  const visitorTwo = 'visitor-22222222222222222222222222222222';
  await presenceStore.recordPresence(visitorOne, 'site-tab', { inGame: false });
  await presenceStore.recordPresence(visitorOne, 'game-tab', {
    playerId: 'ply-alpha',
    inGame: true,
    gameMode: 'single-player',
  });
  await presenceStore.recordPresence(visitorTwo, 'site-tab', { inGame: false });

  assert.deepEqual(await presenceStore.getCounts(), {
    online: 2,
    inGame: 1,
    windowSeconds: 90,
  });

  await presenceStore.removePresence(visitorOne, 'game-tab');
  assert.deepEqual(await presenceStore.getCounts(), {
    online: 2,
    inGame: 0,
    windowSeconds: 90,
  });

  await fs.rm(directory, { recursive: true, force: true });
});

test('presence rejects invalid visitor identifiers', async () => {
  const presenceStore = require('../src/stores/presenceStore.js');
  await assert.rejects(
    () => presenceStore.recordPresence('guest-player', 'site-tab'),
    /Invalid visitor ID/,
  );
});

test('presence identity issues a reusable HTTP-only visitor cookie', () => {
  const presenceIdentity = require('../src/services/presenceIdentity.js');
  const visitorId = presenceIdentity.createVisitorId();
  const cookie = presenceIdentity.createPresenceCookie(visitorId);

  assert.match(visitorId, /^visitor-[a-f0-9]{32}$/);
  assert.match(cookie, /HttpOnly/);
  assert.equal(presenceIdentity.resolveVisitorId(cookie), visitorId);
});

test('GitHub Pages testing receives a secure partitioned presence cookie', () => {
  const presenceIdentity = require('../src/services/presenceIdentity.js');
  const cookie = presenceIdentity.createPresenceCookie(
    presenceIdentity.createVisitorId(),
    'https://cryptosodi.github.io',
  );

  assert.match(cookie, /SameSite=None/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Partitioned/);
});

test('anonymous visitors cannot be marked as in-game', async () => {
  const presenceStore = require('../src/stores/presenceStore.js');
  const visitor = 'visitor-33333333333333333333333333333333';
  await presenceStore.recordPresence(visitor, 'anonymous-tab', { inGame: true });
  assert.equal((await presenceStore.getCounts()).inGame, 0);
});
