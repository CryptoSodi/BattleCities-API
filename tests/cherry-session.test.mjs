import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);

test('Cherry session exchange verifies tokens and keeps one player across wallet changes', async () => {
  process.env.BATTLECITY_PLAYER_DIR = await mkdtemp(path.join(os.tmpdir(), 'cherry-api-player-'));
  process.env.BATTLECITY_SESSION_DIR = await mkdtemp(path.join(os.tmpdir(), 'cherry-api-session-'));
  const auth = require('../dist/src/services/cherryAuth.js');
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'test'; jwk.alg = 'RS256'; jwk.use = 'sig';
  auth.verifyCherryLaunchToken = auth.createVerifier({ jwks: { keys: [jwk] } });
  const route = require('../dist/src/routes/cherrySession.js');
  const api = require('../dist/src/app.js');
  const token = async ({wallet='11111111111111111111111111111111', aud=auth.APP_ID,
    iss='https://chat.cherry.fun', exp=Math.floor(Date.now()/1000)+60} = {}) => new SignJWT({
      app_id:auth.APP_ID, cherry_id:'stable-cherry-user', user:{display_name:'Commander'},
    }).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(iss).setAudience(aud)
      .setSubject(wallet).setExpirationTime(exp).sign(privateKey);
  const exchange = (value, origin='https://cherry.battlecities.com') => route.POST(new Request('https://api.battlecities.com/api/auth/cherry', {
    method:'POST', headers:{origin,authorization:`Bearer ${value}`},
  }));
  const a = await exchange(await token());
  const b = await exchange(await token({wallet:'SysvarRent111111111111111111111111111111111'}));
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  assert.equal(a.headers.get('set-cookie'), null);
  assert.equal(a.headers.get('cache-control'), 'no-store');
  const first = await a.json(), second = await b.json();
  assert.equal(first.player.id, second.player.id);
  assert.notEqual(first.player.walletAddress, second.player.walletAddress);
  assert.match(first.sessionToken, /^sess-/);
  const apiRequest = (path, token, origin='https://cherry.battlecities.com') => api.dispatch(new Request(`https://api.battlecities.com${path}`, {
    headers:{origin,authorization:`Bearer ${token}`},
  }));
  const currentSession = await apiRequest('/api/session', first.sessionToken);
  assert.equal((await currentSession.json()).provider, 'cherry');
  const currentPlayer = await apiRequest('/api/player', first.sessionToken);
  const current = await currentPlayer.json();
  assert.equal(current.player.id, first.player.id);
  assert.equal(current.player.walletAddress, first.player.walletAddress);
  const account = await apiRequest('/api/economy/account', first.sessionToken);
  assert.equal(account.status, 200);
  assert.equal((await account.json()).authenticated, true);
  const postAccount = await api.dispatch(new Request('https://api.battlecities.com/api/economy/fuel/consume', {
    method:'POST', headers:{origin:'https://cherry.battlecities.com',authorization:`Bearer ${first.sessionToken}`,'content-type':'application/json'},
    body:JSON.stringify({expectedPlayerId:first.player.id,requestId:'e838d674-1d53-4bc2-8748-e3755c1de923',tankTier:0}),
  }));
  assert.equal(postAccount.status, 200);
  assert.equal((await apiRequest('/api/session', 'sess-fake-123')).status, 401);
  assert.equal((await apiRequest('/api/session', first.sessionToken, 'https://example.com')).status, 403);
  for (const invalid of [{aud:'other-app'}, {iss:'https://example.com'}, {exp:Math.floor(Date.now()/1000)-1}]) {
    assert.equal((await exchange(await token(invalid))).status, 401);
  }
  assert.equal((await exchange(await token(), 'https://example.com')).status, 403);
});
