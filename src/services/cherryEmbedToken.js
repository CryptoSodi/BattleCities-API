const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const EXPECTED_APP_ID = '148185d2-9181-4e2f-9e4d-47e5b5c12f2a';

function isConfigured() {
  return readAppId() === EXPECTED_APP_ID && readSecret() !== '';
}

function mintToken(walletAddress) {
  const appId = readAppId();
  const secret = readSecret();
  if (appId !== EXPECTED_APP_ID || secret === '') {
    throw new Error('Cherry embed token service is not configured');
  }

  return jwt.sign(
    {
      sub: walletAddress,
      app_id: appId,
    },
    secret,
    {
      algorithm: 'HS256',
      expiresIn: '5m',
      jwtid: crypto.randomUUID(),
    },
  );
}

function readAppId() {
  return String(process.env.CHERRY_APP_ID || '').trim();
}

function readSecret() {
  return String(process.env.CHERRY_APP_SECRET || '').trim();
}

module.exports = {
  EXPECTED_APP_ID,
  isConfigured,
  mintToken,
};
