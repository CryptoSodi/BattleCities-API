const crypto = require('node:crypto');
const ORIGIN = 'https://magic.battlecities.com';
function allowed(request, env = process.env) {
  return env.BATTLECITY_ENVIRONMENT === 'devnet' && env.BATTLECITY_SOLANA_NETWORK === 'devnet'
    && env.BATTLECITY_MAGICBLOCK_ENABLED === '1' && request.headers.get('origin') === ORIGIN;
}
function sign(payload, secret) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return data + '.' + crypto.createHmac('sha256', secret).update(data).digest('base64url');
}
function verify(token, secret, playerId) {
  if (typeof token !== 'string' || token.length > 2048) throw new Error('Invalid session');
  const [data, signature, extra] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(data || '').digest();
  const actual = Buffer.from(signature || '', 'base64url');
  if (extra || expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw new Error('Invalid session');
  const session = JSON.parse(Buffer.from(data, 'base64url'));
  if (session.playerId !== playerId || session.mode !== 'magicblock' || session.expires <= Date.now()) throw new Error('Expired or foreign session');
  return session;
}
module.exports = { allowed, sign, verify, ORIGIN };
