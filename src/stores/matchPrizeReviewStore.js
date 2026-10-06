const fs = require('fs').promises;
const path = require('path');
const database = require('../database');
const storage = require('../config/storageConfig');
const dir = () => process.env.BATTLECITY_MATCH_DIR || path.join(process.cwd(), 'server-data', 'match-results');
let queue = Promise.resolve();

async function list(limit = 50, before = null) {
  if (storage.hasDatabaseConfig()) {
    await database.assertMigrationsApplied();
    const result = await database.getPool().query(`SELECT m.id, m.player_id, m.season_id, m.score,
      m.level_number, m.game_points, m.won, m.replay_id, m.created_at, m.validation_status
      FROM battlecity_match_results m LEFT JOIN battlecity_match_prize_reviews r ON r.result_id = m.id
      WHERE r.result_id IS NULL AND m.provider <> 'guest' AND ($1::text IS NULL OR m.id < $1)
      ORDER BY m.id DESC LIMIT $2`, [before, limit]);
    return result.rows;
  }
  let files;
  try { files = await fs.readdir(dir()); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const rows = [];
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    const r = JSON.parse(await fs.readFile(path.join(dir(), file), 'utf8'));
    if (!r.prizeReview && r.provider !== 'guest' && (!before || r.id < before)) rows.push({
      id: r.id, player_id: r.playerId, season_id: r.seasonId, score: r.score, level_number: r.levelNumber,
      game_points: r.gamePoints, won: r.won, replay_id: r.replayId, created_at: r.createdAt, validation_status: r.validationStatus });
  }
  return rows.sort((a, b) => b.id.localeCompare(a.id)).slice(0, limit);
}
async function review(id, decision, reason, reviewerId) {
  if (typeof id !== 'string' || !/^mtc-[a-z0-9-]{1,100}$/i.test(id)) throw new Error('Invalid match result id.');
  if (!['accepted', 'rejected'].includes(decision)) throw new Error('Decision must be accepted or rejected.');
  if (typeof reason !== 'string' || reason.trim().length < 5 || reason.length > 1000) throw new Error('Provide a review reason (5–1000 characters).');
  const value = { decision, reason: reason.trim(), reviewerId, reviewedAt: new Date().toISOString() };
  if (storage.hasDatabaseConfig()) {
    await database.assertMigrationsApplied();
    return database.withTransaction(async () => {
      const db = database.getPool();
      const result = await db.query("SELECT id FROM battlecity_match_results WHERE id = $1 AND provider <> 'guest' FOR UPDATE", [id]);
      if (!result.rowCount) throw new Error('Match result not found.');
      const existing = await db.query('SELECT * FROM battlecity_match_prize_reviews WHERE result_id = $1', [id]);
      if (existing.rowCount) {
        if (existing.rows[0].decision !== decision) throw new Error('Match prize review is already final.');
        return { id, decision: existing.rows[0].decision, reviewedAt: new Date(existing.rows[0].reviewed_at).toISOString() };
      }
      await db.query(`INSERT INTO battlecity_match_prize_reviews (result_id, decision, reviewer_id, reason)
        VALUES ($1,$2,$3,$4)`, [id, decision, reviewerId, value.reason]);
      await db.query('UPDATE battlecity_match_results SET validation_status = $2 WHERE id = $1', [id, decision]);
      return { id, ...value };
    });
  }
  const run = async () => {
    const file = path.join(dir(), `${id}.json`);
    const row = JSON.parse(await fs.readFile(file, 'utf8'));
    if (row.provider === 'guest') throw new Error('Guest matches are not prize eligible.');
    if (row.prizeReview) {
      if (row.prizeReview.decision !== decision) throw new Error('Match prize review is already final.');
      return { id, ...row.prizeReview };
    }
    row.validationStatus = decision; row.prizeReview = value;
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(row)); await fs.rename(temporary, file);
    return { id, ...value };
  };
  const next = queue.then(run, run); queue = next.catch(() => {}); return next;
}
module.exports = { list, review };
