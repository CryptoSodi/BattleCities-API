const crypto = require('crypto');
const database = require('../database');
const storageConfig = require('../config/storageConfig');
const economyStore = require('./economyStore');

function enabled() { return storageConfig.hasDatabaseConfig(); }
function parsePost(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/(?:status\/)?(\d{1,20})$/);
  if (!match) throw Object.assign(new Error('Provide an X post URL or post ID'), { code: 'INVALID_X_TASK' });
  return { id: match[1], url: raw.startsWith('http') ? raw : `https://x.com/BattleCitiesHQ/status/${match[1]}` };
}
async function list(playerId = null) {
  if (!enabled()) return [];
  await database.assertMigrationsApplied();
  const result = await database.getPool().query(
    `SELECT t.*, EXISTS(SELECT 1 FROM battlecity_x_repost_claims c WHERE c.task_id=t.id AND c.player_id=$1) claimed
     FROM battlecity_x_repost_tasks t ORDER BY t.created_at DESC`, [playerId],
  );
  return result.rows.map(row => ({ id: row.id, postId: row.post_id, postUrl: row.post_url, rewardFuel: row.reward_fuel, active: row.active, claimed: row.claimed, createdAt: row.created_at }));
}
async function create(adminPlayerId, post) {
  if (!enabled()) throw Object.assign(new Error('Database is required'), { code: 'DATABASE_REQUIRED' });
  const parsed = parsePost(post);
  await database.assertMigrationsApplied();
  return database.withTransaction(async () => {
    const pool = database.getPool();
    await pool.query('UPDATE battlecity_x_repost_tasks SET active=FALSE WHERE active=TRUE');
    const id = `xrt-${crypto.randomBytes(8).toString('hex')}`;
    const result = await pool.query(
      `INSERT INTO battlecity_x_repost_tasks (id,post_id,post_url,created_by_player_id) VALUES ($1,$2,$3,$4) RETURNING *`,
      [id, parsed.id, parsed.url, adminPlayerId],
    );
    return { id, postId: parsed.id, postUrl: parsed.url, rewardFuel: 5, active: true, createdAt: result.rows[0].created_at };
  });
}
async function activeForPlayer(playerId) {
  return (await list(playerId)).find(task => task.active && !task.claimed) || null;
}
async function activeForStatus(playerId) {
  return (await list(playerId)).find(task => task.active) || null;
}
async function claim(player, xUserId, taskId) {
  if (!enabled()) throw Object.assign(new Error('Database is required'), { code: 'DATABASE_REQUIRED' });
  await database.assertMigrationsApplied();
  return database.withTransaction(async () => {
    const pool = database.getPool();
    const task = (await pool.query('SELECT * FROM battlecity_x_repost_tasks WHERE id=$1 AND active=TRUE FOR UPDATE', [taskId])).rows[0];
    if (!task) return { ok:false, error:'Task is no longer active' };
    const receipt = await pool.query(`INSERT INTO battlecity_x_repost_claims (task_id,player_id,x_user_id,fuel_amount) VALUES ($1,$2,$3,5) ON CONFLICT DO NOTHING RETURNING task_id`, [task.id,player.id,xUserId]);
    if (receipt.rowCount === 0) return { ok:true, granted:false, taskId:task.id };
    await economyStore.creditFuel(player, 5, { reason:'x-repost-reward', sourceType:'x-repost-task', sourceId:task.id });
    return { ok:true, granted:true, taskId:task.id };
  });
}
module.exports = { activeForPlayer, activeForStatus, claim, create, list };
