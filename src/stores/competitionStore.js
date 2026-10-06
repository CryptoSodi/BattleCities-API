const fs = require('fs').promises;
const path = require('path');
const database = require('../database');
const storageConfig = require('../config/storageConfig');

let fileQueue = Promise.resolve();
async function local(operation, write = false) {
  const run = async () => {
    const file = process.env.BATTLECITY_COMPETITIONS_FILE
      || path.join(process.cwd(), 'server-data', 'competitions.json');
    let state = { settings: null, passes: [], periods: [], payouts: [] };
    try { state = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const result = await operation(state);
    if (write) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(state));
      await fs.rename(temporary, file);
    }
    return result;
  };
  const next = fileQueue.then(run, run);
  fileQueue = next.catch(() => {});
  return next;
}
async function query(sql, args = []) {
  await database.assertMigrationsApplied();
  return database.getPool().query(sql, args);
}
const persistent = () => storageConfig.hasDatabaseConfig();
const iso = (value) => value == null ? null : new Date(value).toISOString();

async function getSettings() {
  if (!persistent()) return local((s) => s.settings);
  const result = await query('SELECT settings FROM battlecity_competition_settings WHERE id = 1');
  return result.rows[0]?.settings || null;
}
async function saveSettings(settings, adminId) {
  if (!persistent()) return local((s) => { s.settings = settings; return settings; }, true);
  await query(`INSERT INTO battlecity_competition_settings (id, settings, updated_by)
    VALUES (1, $1::jsonb, $2) ON CONFLICT (id) DO UPDATE SET
    settings = EXCLUDED.settings, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
  [JSON.stringify(settings), adminId]);
  return settings;
}
async function getPass(playerId, seasonId) {
  if (!persistent()) return local((s) => s.passes.find((p) => p.playerId === playerId && p.seasonId === seasonId) || null);
  const result = await query('SELECT * FROM battlecity_season_passes WHERE player_id = $1 AND season_id = $2', [playerId, seasonId]);
  return result.rows[0] ? passFromRow(result.rows[0]) : null;
}
async function listPasses(seasonId) {
  if (!persistent()) return local((s) => s.passes.filter((p) => p.seasonId === seasonId));
  return (await query('SELECT * FROM battlecity_season_passes WHERE season_id = $1', [seasonId])).rows.map(passFromRow);
}
async function grantPass(playerId, season, signature, purchasedAt) {
  const bought = Date.parse(purchasedAt);
  if (!Number.isFinite(bought) || bought < Date.parse(season.startsAt) || bought >= Date.parse(season.endsAt)) {
    throw new Error('Season pass payment falls outside this season.');
  }
  const pass = { playerId, seasonId: season.id, purchasedAt: iso(bought),
    eligibleFrom: iso(season.startsAt),
    expiresAt: iso(season.endsAt), paymentSignature: signature };
  if (!persistent()) return local((s) => {
    const existing = s.passes.find((p) => p.playerId === playerId && p.seasonId === season.id);
    if (existing) return existing;
    if (s.passes.some((p) => p.paymentSignature === signature)) throw new Error('Payment already used.');
    s.passes.push(pass); return pass;
  }, true);
  await query(`INSERT INTO battlecity_season_passes
    (player_id, season_id, purchased_at, eligible_from, expires_at, payment_signature)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (player_id, season_id) DO NOTHING`,
  [playerId, season.id, pass.purchasedAt, pass.eligibleFrom, pass.expiresAt, signature]);
  return getPass(playerId, season.id);
}
function passFromRow(r) {
  return { playerId: r.player_id, seasonId: r.season_id, purchasedAt: iso(r.purchased_at),
    eligibleFrom: iso(r.eligible_from), expiresAt: iso(r.expires_at), paymentSignature: r.payment_signature };
}

async function ensurePeriod(period) {
  if (!persistent()) return local((s) => {
    let found = s.periods.find((p) => p.id === period.id);
    if (!found) { found = { ...period, rows: null, closedAt: null }; s.periods.push(found); }
    else if (!found.closedAt) found.policy = period.policy;
    return found;
  }, true);
  await query(`INSERT INTO battlecity_ranking_periods (id, kind, scope, season_id, starts_at, ends_at, policy)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (id) DO UPDATE SET policy = EXCLUDED.policy
    WHERE battlecity_ranking_periods.closed_at IS NULL`,
  [period.id, period.kind, period.scope, period.seasonId || null, period.startsAt, period.endsAt, JSON.stringify(period.policy)]);
  return getPeriod(period.id);
}
async function getPeriod(id) {
  if (!persistent()) return local((s) => s.periods.find((p) => p.id === id) || null);
  const result = await query('SELECT * FROM battlecity_ranking_periods WHERE id = $1', [id]);
  return result.rows[0] ? periodFromRow(result.rows[0]) : null;
}
async function listPeriods({ kind = null, scope = null, before = null, limit = 20, open = false } = {}) {
  if (!persistent()) return local((s) => s.periods.filter((p) =>
    (!kind || p.kind === kind) && (!scope || p.scope === scope)
    && (open ? p.closedAt === null : p.closedAt !== null)
    && (!before || p.endsAt < before)).sort((a, b) => b.endsAt.localeCompare(a.endsAt)).slice(0, limit));
  const result = await query(`SELECT * FROM battlecity_ranking_periods
    WHERE ($1::text IS NULL OR kind = $1) AND ($2::text IS NULL OR scope = $2)
      AND ($3::timestamptz IS NULL OR ends_at < $3)
      AND (CASE WHEN $4 THEN closed_at IS NULL ELSE closed_at IS NOT NULL END)
    ORDER BY ends_at DESC, id DESC LIMIT $5`, [kind, scope, before, open, limit]);
  return result.rows.map(periodFromRow);
}
async function closePeriod(id, rows, payouts) {
  if (!persistent()) return local((s) => {
    const p = s.periods.find((item) => item.id === id);
    if (!p) throw new Error('Unknown ranking period.');
    if (p.closedAt) return p;
    p.rows = rows; p.closedAt = new Date().toISOString();
    s.payouts.push(...payouts.map((item) => ({ ...item, createdAt: p.closedAt, delivery: null, error: null, paidAt: null })));
    return p;
  }, true);
  return database.withTransaction(async () => {
    const result = await query('SELECT * FROM battlecity_ranking_periods WHERE id = $1 FOR UPDATE', [id]);
    const p = result.rows[0];
    if (!p) throw new Error('Unknown ranking period.');
    if (p.closed_at) return periodFromRow(p);
    for (const item of payouts) await query(`INSERT INTO battlecity_ranking_payouts
      (id, period_id, player_id, wallet_address, rank, amount, token_config, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [item.id, id, item.playerId, item.walletAddress, item.rank, item.amount, JSON.stringify(item.tokenConfig), item.status]);
    await query('UPDATE battlecity_ranking_periods SET rows_json = $2::jsonb, closed_at = NOW() WHERE id = $1', [id, JSON.stringify(rows)]);
    return getPeriod(id);
  });
}
function periodFromRow(r) {
  return { id: r.id, kind: r.kind, scope: r.scope, seasonId: r.season_id,
    startsAt: iso(r.starts_at), endsAt: iso(r.ends_at), policy: r.policy, rows: r.rows_json, closedAt: iso(r.closed_at) };
}
async function listPayouts({ periodId = null, playerId = null, before = null, limit = 50, pending = false } = {}) {
  if (!persistent()) return local((s) => s.payouts.filter((p) => (!periodId || p.periodId === periodId)
    && (!playerId || p.playerId === playerId) && (!before || p.id < before)
    && (!pending || ['pending', 'prepared', 'failed'].includes(p.status)))
    .sort((a, b) => b.id.localeCompare(a.id)).slice(0, limit));
  const result = await query(`SELECT * FROM battlecity_ranking_payouts
    WHERE ($1::text IS NULL OR period_id = $1) AND ($2::text IS NULL OR player_id = $2)
      AND ($3::text IS NULL OR id < $3)
      AND (NOT $4 OR status IN ('pending','prepared','failed'))
    ORDER BY id DESC LIMIT $5`, [periodId, playerId, before, pending, limit]);
  return result.rows.map(payoutFromRow);
}
async function getPayout(id) {
  if (!persistent()) return local((s) => s.payouts.find((p) => p.id === id) || null);
  const result = await query('SELECT * FROM battlecity_ranking_payouts WHERE id = $1', [id]);
  return result.rows[0] ? payoutFromRow(result.rows[0]) : null;
}
async function preparePayout(id, expectedSignature, delivery) {
  if (!persistent()) return local((s) => {
    const p = s.payouts.find((item) => item.id === id);
    if (p && p.status !== 'paid' && (p.delivery?.signature || null) === expectedSignature) {
      p.delivery = delivery; p.status = 'prepared'; p.error = null;
    }
    return p || null;
  }, true);
  await query(`UPDATE battlecity_ranking_payouts SET delivery = $3::jsonb, status = 'prepared', error = NULL
    WHERE id = $1 AND status <> 'paid' AND (delivery->>'signature') IS NOT DISTINCT FROM $2::text`,
  [id, expectedSignature, JSON.stringify(delivery)]);
  return getPayout(id);
}
async function finishPayout(id, signature, error = null) {
  if (!persistent()) return local((s) => {
    const p = s.payouts.find((item) => item.id === id);
    if (p && p.status !== 'paid' && p.delivery?.signature === signature) {
      p.status = error ? 'failed' : 'paid'; p.error = error; p.paidAt = error ? null : new Date().toISOString();
    }
    return p || null;
  }, true);
  await query(`UPDATE battlecity_ranking_payouts SET status = $3, error = $4,
    paid_at = CASE WHEN $4::text IS NULL THEN NOW() ELSE NULL END
    WHERE id = $1 AND delivery->>'signature' = $2 AND status <> 'paid'`,
  [id, signature, error ? 'failed' : 'paid', error]);
  return getPayout(id);
}
function payoutFromRow(r) {
  return { id: r.id, periodId: r.period_id, playerId: r.player_id, walletAddress: r.wallet_address,
    rank: r.rank, amount: r.amount, tokenConfig: r.token_config, status: r.status,
    delivery: r.delivery, error: r.error, paidAt: iso(r.paid_at), createdAt: iso(r.created_at) };
}
module.exports = { getSettings, saveSettings, getPass, listPasses, grantPass, ensurePeriod,
  getPeriod, listPeriods, closePeriod, listPayouts, getPayout, preparePayout, finishPayout };
