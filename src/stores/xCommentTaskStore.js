const crypto = require('crypto');
const database = require('../database');
const storageConfig = require('../config/storageConfig');
const economyStore = require('./economyStore');
const { parsePost } = require('./xRepostTaskStore');
function enabled() { return storageConfig.hasDatabaseConfig(); }
async function list(playerId = null) {
  if (!enabled()) return [];
  await database.assertMigrationsApplied();
  const r = await database.getPool().query(`SELECT t.*, EXISTS(SELECT 1 FROM battlecity_x_comment_claims c WHERE c.task_id=t.id AND c.player_id=$1) claimed FROM battlecity_x_comment_tasks t ORDER BY t.created_at DESC`, [playerId]);
  return r.rows.map(x => ({ id:x.id, postId:x.post_id, postUrl:x.post_url, rewardFuel:x.reward_fuel, active:x.active, claimed:x.claimed, createdAt:x.created_at }));
}
async function create(adminPlayerId, post) {
  if (!enabled()) throw new Error('Database is required');
  const item=parsePost(post); await database.assertMigrationsApplied();
  return database.withTransaction(async()=>{ const p=database.getPool(); await p.query('UPDATE battlecity_x_comment_tasks SET active=FALSE WHERE active=TRUE'); const id=`xct-${crypto.randomBytes(8).toString('hex')}`; const r=await p.query('INSERT INTO battlecity_x_comment_tasks (id,post_id,post_url,created_by_player_id) VALUES ($1,$2,$3,$4) RETURNING *',[id,item.id,item.url,adminPlayerId]); return {id,postId:item.id,postUrl:item.url,rewardFuel:5,active:true,createdAt:r.rows[0].created_at}; });
}
async function activeForPlayer(playerId) { return (await list(playerId)).find(x=>x.active&&!x.claimed)||null; }
async function activeForStatus(playerId) { return (await list(playerId)).find(x=>x.active)||null; }
async function claim(player,xUserId,taskId) { await database.assertMigrationsApplied(); return database.withTransaction(async()=>{const p=database.getPool();const t=(await p.query('SELECT * FROM battlecity_x_comment_tasks WHERE id=$1 AND active=TRUE FOR UPDATE',[taskId])).rows[0];if(!t)return{ok:false,error:'Task is no longer active'};const r=await p.query('INSERT INTO battlecity_x_comment_claims (task_id,player_id,x_user_id,fuel_amount) VALUES ($1,$2,$3,5) ON CONFLICT DO NOTHING RETURNING task_id',[t.id,player.id,xUserId]);if(!r.rowCount)return{ok:true,granted:false};await economyStore.creditFuel(player,5,{reason:'x-comment-reward',sourceType:'x-comment-task',sourceId:t.id});return{ok:true,granted:true};}); }
module.exports={list,create,activeForPlayer,activeForStatus,claim};
