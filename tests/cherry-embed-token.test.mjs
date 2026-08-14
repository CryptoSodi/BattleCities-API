import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');
const cherryEmbedToken = require('../src/services/cherryEmbedToken.js');

test('Cherry embed token uses the exact HS256 contract', () => {
  const previousAppId = process.env.CHERRY_APP_ID;
  const previousSecret = process.env.CHERRY_APP_SECRET;
  process.env.CHERRY_APP_ID = '148185d2-9181-4e2f-9e4d-47e5b5c12f2a';
  process.env.CHERRY_APP_SECRET = 'test-only-secret-not-used-in-production';

  try {
    const walletAddress = '9xQeWvG816bUx9EPfEZm9bUd4eYzY3hN8Y8Y4JjGmY6V';
    const token = cherryEmbedToken.mintToken(walletAddress);
    const decoded = jwt.verify(token, process.env.CHERRY_APP_SECRET, {
      algorithms: ['HS256'],
    });

    assert.equal(decoded.sub, walletAddress);
    assert.equal(decoded.app_id, process.env.CHERRY_APP_ID);
    assert.equal(typeof decoded.jti, 'string');
    assert.equal(decoded.exp - decoded.iat, 300);
    assert.deepEqual(
      Object.keys(decoded).sort(),
      ['app_id', 'exp', 'iat', 'jti', 'sub'].sort(),
    );
  } finally {
    restoreEnv('CHERRY_APP_ID', previousAppId);
    restoreEnv('CHERRY_APP_SECRET', previousSecret);
  }
});

test('Cherry embed token fails closed without the configured secret', () => {
  const previousAppId = process.env.CHERRY_APP_ID;
  const previousSecret = process.env.CHERRY_APP_SECRET;
  process.env.CHERRY_APP_ID = '148185d2-9181-4e2f-9e4d-47e5b5c12f2a';
  delete process.env.CHERRY_APP_SECRET;

  try {
    assert.equal(cherryEmbedToken.isConfigured(), false);
    assert.throws(
      () => cherryEmbedToken.mintToken('wallet-address'),
      /not configured/,
    );
  } finally {
    restoreEnv('CHERRY_APP_ID', previousAppId);
    restoreEnv('CHERRY_APP_SECRET', previousSecret);
  }
});

test('Cherry token route binds the request to the authenticated wallet', async () => {
  const source = await fs.readFile(
    new URL('../src/routes/cherryEmbedToken.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /resolveSessionPlayer\(request\)/);
  assert.match(source, /player\.provider !== 'wallet'/);
  assert.match(source, /body\.walletAddress !== player\.walletAddress/);
  assert.doesNotMatch(source, /CHERRY_APP_SECRET/);
});

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
