const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const database = require('../database');
const storage = require('../config/storageConfig');
let queue = Promise.resolve();
function hash(token) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(token))) throw new Error('Invalid OAuth flow.');
  return crypto.createHash('sha256').update(token).digest('hex');
}
async function local(tokenHash, operation, create = null) {
  const run = async () => {
    const dir = process.env.BATTLECITY_NATIVE_OAUTH_DIR || path.join(process.cwd(), 'server-data', 'native-oauth');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${tokenHash}.json`);
    let row = create;
    if (!row) { try { row = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
    const result = await operation(row);
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(row), { mode: 0o600 });
    await fs.rename(temporary, file);
    return result;
  };
  const next = queue.then(run, run); queue = next.catch(() => {}); return next;
}
async function query(sql, args) {
  await database.assertMigrationsApplied(); return database.getPool().query(sql, args);
}
async function create(provider, playerId, payload) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const tokenHash = hash(token);
  if (storage.hasDatabaseConfig()) {
    await query('DELETE FROM battlecity_native_oauth WHERE expires_at < NOW() - INTERVAL \'1 day\'', []);
    await query(`INSERT INTO battlecity_native_oauth (token_hash, provider, player_id, payload, status, expires_at)
      VALUES ($1,$2,$3,$4::jsonb,'pending',$5)`, [tokenHash, provider, playerId, JSON.stringify(payload), expiresAt]);
  } else await local(tokenHash, () => null, { provider, playerId, payload, status: 'pending', expiresAt });
  return { token, expiresAt };
}
async function consume(token, provider) {
  const tokenHash = hash(token);
  if (storage.hasDatabaseConfig()) {
    const result = await query(`UPDATE battlecity_native_oauth SET status = 'exchanging'
      WHERE token_hash = $1 AND provider = $2 AND status = 'pending' AND expires_at > NOW()
      RETURNING player_id, payload`, [tokenHash, provider]);
    return result.rows[0] ? { playerId: result.rows[0].player_id, payload: result.rows[0].payload } : null;
  }
  return local(tokenHash, (row) => {
    if (row.provider !== provider || row.status !== 'pending' || Date.parse(row.expiresAt) <= Date.now()) return null;
    row.status = 'exchanging'; return { playerId: row.playerId, payload: row.payload };
  });
}
async function finish(token, status) {
  if (!['completed', 'failed'].includes(status)) throw new Error('Invalid OAuth outcome.');
  if (storage.hasDatabaseConfig()) await query(`UPDATE battlecity_native_oauth SET status = $2, payload = '{}'::jsonb
    WHERE token_hash = $1 AND status = 'exchanging'`, [hash(token), status]);
  else await local(hash(token), (row) => { if (row.status === 'exchanging') { row.status = status; row.payload = {}; } });
}
async function readStatus(token, playerId) {
  const tokenHash = hash(token);
  if (storage.hasDatabaseConfig()) {
    const result = await query('SELECT provider, status, expires_at FROM battlecity_native_oauth WHERE token_hash = $1 AND player_id = $2', [tokenHash, playerId]);
    const r = result.rows[0]; return r ? publicStatus(r.provider, r.status, r.expires_at) : null;
  }
  return local(tokenHash, (r) => r.playerId === playerId ? publicStatus(r.provider, r.status, r.expiresAt) : null);
}
function publicStatus(provider, status, expiresAt) {
  return { provider, status: ['pending', 'exchanging'].includes(status) && new Date(expiresAt).getTime() <= Date.now() ? 'expired' : status,
    expiresAt: new Date(expiresAt).toISOString() };
}
module.exports = { create, consume, finish, readStatus };
