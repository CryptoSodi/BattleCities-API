const fs = require('fs').promises;
const path = require('path');
const database = require('../database');
const storage = require('../config/storageConfig');
function file(signature) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) throw new Error('Invalid swap signature.');
  return path.join(process.env.BATTLECITY_SWAP_EXECUTIONS_DIR || path.join(process.cwd(), 'server-data', 'swap-executions'), `${signature}.json`);
}
async function record(playerId, signature, requestId) {
  const target = file(signature);
  if (storage.hasDatabaseConfig()) {
    await database.assertMigrationsApplied();
    await database.getPool().query(`INSERT INTO battlecity_swap_executions (signature, player_id, request_id)
      VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [signature, playerId, requestId]);
  } else {
    await fs.mkdir(path.dirname(target), { recursive: true });
    try { await fs.writeFile(target, JSON.stringify({ playerId, requestId }), { flag: 'wx' }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  if (!await isVerified(playerId, signature)) throw new Error('Swap execution belongs to another player.');
}
async function isVerified(playerId, signature) {
  const target = file(signature);
  if (storage.hasDatabaseConfig()) {
    await database.assertMigrationsApplied();
    const result = await database.getPool().query('SELECT 1 FROM battlecity_swap_executions WHERE signature = $1 AND player_id = $2', [signature, playerId]);
    return result.rowCount > 0;
  }
  try { return JSON.parse(await fs.readFile(target, 'utf8')).playerId === playerId; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
module.exports = { record, isVerified };
