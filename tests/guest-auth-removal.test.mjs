import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);

test('guest player and session creation are unavailable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'battlecities-auth-'));
  const sessionDir = path.join(root, 'sessions');
  const playerDir = path.join(root, 'players');
  process.env.NODE_ENV = 'development';
  process.env.BATTLECITY_STORAGE_MODE = 'local';
  process.env.BATTLECITY_SESSION_DIR = sessionDir;
  process.env.BATTLECITY_PLAYER_DIR = playerDir;

  const sessionStore = require('../src/stores/sessionStore');
  const playerStore = require('../src/stores/playerStore');
  assert.equal(sessionStore.createGuestSession, undefined);
  assert.equal(playerStore.createGuestPlayer, undefined);

  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(playerDir, { recursive: true });
  const now = new Date().toISOString();
  await fs.writeFile(
    path.join(sessionDir, 'sess-legacy-guest.json'),
    JSON.stringify({
      id: 'sess-legacy-guest',
      provider: 'guest',
      playerId: 'ply-legacy-guest',
      createdAt: now,
      lastSeenAt: now,
      walletAddress: null,
    }),
  );
  await fs.writeFile(
    path.join(playerDir, 'ply-legacy-guest.json'),
    JSON.stringify({
      id: 'ply-legacy-guest',
      provider: 'guest',
      displayName: 'Legacy Guest',
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    }),
  );

  assert.equal(await sessionStore.readSession('sess-legacy-guest'), null);
  assert.equal(await playerStore.readPlayer('ply-legacy-guest'), null);
});

test('session login route accepts wallet authentication only', async () => {
  const source = await fs.readFile(
    new URL('../src/routes/session.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /body\?\.provider !== 'wallet'/);
  assert.doesNotMatch(source, /createGuestSession|provider === 'guest'/);
});
