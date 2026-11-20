import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { jwtVerify } from 'jose';
import test from 'node:test';

const require = createRequire(import.meta.url);
test('chat tokens use only a verified Cherry session and never a supplied wallet', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'battlecities-cherry-chat-'));
  process.env.BATTLECITY_STORAGE_MODE = 'local';
  process.env.BATTLECITY_PLAYER_DIR = path.join(root, 'players');
  process.env.BATTLECITY_SESSION_DIR = path.join(root, 'sessions');
  process.env.BATTLECITY_CHERRY_CHAT_EMBED_ID = 'test-chat-embed';
  process.env.BATTLECITY_CHERRY_CHAT_ROOM_ID = 'test-room';
  process.env.BATTLECITY_CHERRY_CHAT_SECRET = 'test-chat-secret-only-for-tests';
  try {
    const sessions = require('../dist/src/stores/sessionStore');
    const api = require('../dist/src/app');
    const session = await sessions.createCherrySession('person', '11111111111111111111111111111111', 'Test');
    const guest = await sessions.createGuestSession();
    const request = (id, origin = 'https://cherry.battlecities.com') => api.dispatch(new Request('https://api.battlecities.com/api/auth/cherry-chat', {
      method: 'POST', headers: { origin, authorization: `Bearer ${id}`, 'content-type': 'application/json' },
      body: JSON.stringify({ walletAddress: 'attacker-controlled-address' }),
    }));
    const response = await request(session.id);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(result.appId, 'test-chat-embed');
    assert.equal(result.roomId, 'test-room');
    const { payload } = await jwtVerify(result.token, new TextEncoder().encode(process.env.BATTLECITY_CHERRY_CHAT_SECRET), { algorithms: ['HS256'] });
    assert.equal(payload.sub, session.walletAddress);
    assert.equal(payload.app_id, 'test-chat-embed');
    assert.equal(payload.exp - payload.iat, 300);
    assert.ok(payload.jti);
    assert.equal((await request(guest.id)).status, 401);
    assert.equal((await request(session.id, 'https://example.com')).status, 403);
    delete process.env.BATTLECITY_CHERRY_CHAT_SECRET;
    assert.equal((await request(session.id)).status, 503);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
