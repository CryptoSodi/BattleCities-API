import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import cherryAuth from '../src/services/cherryAuth.js';

test('Cherry launch verification enforces signature, issuer, audience, app ID and expiry', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const key = await exportJWK(publicKey);
  key.kid = 'test'; key.alg = 'RS256'; key.use = 'sig';
  const verify = cherryAuth.createVerifier({ jwks: { keys: [key] } });
  const wallet = '11111111111111111111111111111111';
  const sign = async (overrides = {}, header = {}) => new SignJWT({
    app_id: cherryAuth.APP_ID, cherry_id: 'cherry-person', ...overrides,
  }).setProtectedHeader({ alg: 'RS256', kid: 'test', ...header })
    .setIssuer(overrides.iss ?? 'https://chat.cherry.fun')
    .setAudience(overrides.aud ?? cherryAuth.APP_ID)
    .setSubject(wallet)
    .setExpirationTime(overrides.exp ?? Math.floor(Date.now() / 1000) + 60)
    .sign(privateKey);
  const valid = await verify(await sign());
  assert.equal(valid.userKey, 'cherry-person');
  assert.equal(valid.wallet, wallet);
  const fallback = await verify(await sign({ cherry_id: undefined }));
  assert.equal(fallback.userKey, wallet);
  for (const claims of [
    { iss: 'https://example.com' }, { aud: 'wrong-app' },
    { app_id: 'wrong-app' }, { exp: Math.floor(Date.now() / 1000) - 1 },
  ]) await assert.rejects(verify(await sign(claims)));
  const noAudience = await new SignJWT({ app_id: cherryAuth.APP_ID }).setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer('https://chat.cherry.fun').setSubject(wallet).setExpirationTime('1m').sign(privateKey);
  await assert.rejects(verify(noAudience));
  const bad = await generateKeyPair('RS256');
  const forged = await new SignJWT({ app_id: cherryAuth.APP_ID }).setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer('https://chat.cherry.fun').setAudience(cherryAuth.APP_ID).setSubject(wallet)
    .setExpirationTime('1m').sign(bad.privateKey);
  await assert.rejects(verify(forged));
});
