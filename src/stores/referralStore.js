const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const database = require('../database');
const storageConfig = require('../config/storageConfig');
const playerStore = require('./playerStore');

let localLock = Promise.resolve();
function filePath() {
  return process.env.BATTLECITY_REFERRALS_FILE || path.join(process.env.BATTLECITY_ECONOMY_DIR || path.join(process.cwd(), 'server-data', 'economy'), 'referrals.json');
}
async function readLocal() {
  try { return JSON.parse(await fs.readFile(filePath(), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { startedAt: new Date().toISOString(), profiles: {}, referrals: {}, rewards: {} }; }
}
function mutateLocal(fn) {
  const next = localLock.then(async () => {
    const data = await readLocal();
    const result = await fn(data);
    await fs.mkdir(path.dirname(filePath()), { recursive: true });
    const temp = `${filePath()}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(data));
    await fs.rename(temp, filePath());
    return result;
  });
  localLock = next.catch(() => {});
  return next;
}
function codeFromInput(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Enter a valid referral link or code.');
  let code = value.trim();
  if (/^https?:\/\//i.test(code)) {
    let url;
    try { url = new URL(code); } catch { throw new Error('Enter a valid referral link or code.'); }
    if (url.protocol !== 'https:' || !['battlecities.com', 'www.battlecities.com', 'play.battlecities.com', 'test.battlecities.com'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port) throw new Error('Enter a Battle Cities referral link.');
    code = url.searchParams.get('ref') || '';
  }
  code = code.toUpperCase();
  if (!/^[A-F0-9]{12}$/.test(code)) throw new Error('Enter a valid referral link or code.');
  return code;
}
function newCode() { return crypto.randomBytes(6).toString('hex').toUpperCase(); }
function formatAmount(amount, decimals) {
  const base = 10n ** BigInt(decimals), value = BigInt(amount);
  const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (value / base).toString() + (fraction ? `.${fraction}` : '');
}
function publicStatus(code, referred, prompt, rewards) {
  return { code, link: `https://battlecities.com/?ref=${code}`, referred: !!referred, prompt, rewards: rewards.map(r => ({ ...r, amount: formatAmount(r.amountAtomic, r.decimals) })) };
}
async function ensureProfile(player) {
  if (!player || player.provider !== 'wallet') throw new Error('Sign in to use referrals.');
  if (!storageConfig.hasDatabaseConfig()) return mutateLocal(data => {
    let profile = data.profiles[player.id];
    if (!profile) {
      let code; do { code = newCode(); } while (Object.values(data.profiles).some(p => p.code === code));
      profile = data.profiles[player.id] = { code, dismissed: false };
    }
    const totals = {};
    for (const r of Object.values(data.rewards)) if (r.referrer === player.id) {
      const key=JSON.stringify([r.currency,r.network,r.mint,r.tokenProgram,r.decimals]);
      if (!totals[key]) totals[key]={currency:r.currency,network:r.network,mint:r.mint,tokenProgram:r.tokenProgram,decimals:r.decimals,amountAtomic:'0'};
      totals[key].amountAtomic=(BigInt(totals[key].amountAtomic)+BigInt(r.amountAtomic)).toString();
    }
    const referred = !!data.referrals[player.id];
    return publicStatus(profile.code, referred, !referred && !profile.dismissed && Date.parse(player.createdAt) >= Date.parse(data.startedAt), Object.values(totals));
  });
  await database.assertMigrationsApplied();
  const db = database.getPool();
  // A rare generated-code collision is retried; an existing player's code is stable.
  for (let attempt = 0; attempt < 5; attempt++) {
    const inserted = await db.query(`INSERT INTO battlecity_referral_profiles(player_id, code) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING code`, [player.id, newCode()]);
    if (inserted.rowCount || (await db.query('SELECT 1 FROM battlecity_referral_profiles WHERE player_id=$1', [player.id])).rowCount) break;
    if (attempt === 4) throw new Error('Could not create referral code.');
  }
  const status = await db.query(`SELECT p.code, p.prompt_dismissed, r.referrer_player_id,
      (SELECT started_at FROM battlecity_referral_program WHERE singleton=TRUE) AS started_at
    FROM battlecity_referral_profiles p LEFT JOIN battlecity_referrals r ON r.referred_player_id=p.player_id WHERE p.player_id=$1`, [player.id]);
  const rows = await db.query(`SELECT currency, network, token_mint, token_program, decimals, SUM(amount_atomic)::text AS amount
    FROM battlecity_referral_rewards WHERE referrer_player_id=$1 GROUP BY currency, network, token_mint, token_program, decimals ORDER BY currency`, [player.id]);
  const totals = rows.rows.map(row => ({currency:row.currency,network:row.network,mint:row.token_mint,tokenProgram:row.token_program,decimals:row.decimals,amountAtomic:row.amount}));
  const p = status.rows[0], referred = !!p.referrer_player_id;
  return publicStatus(p.code, referred, !referred && !p.prompt_dismissed && Date.parse(player.createdAt) >= new Date(p.started_at).getTime(), totals);
}
async function dismissPrompt(player) {
  await ensureProfile(player);
  if (!storageConfig.hasDatabaseConfig()) return mutateLocal(data => { data.profiles[player.id].dismissed = true; });
  await database.getPool().query('UPDATE battlecity_referral_profiles SET prompt_dismissed=TRUE WHERE player_id=$1', [player.id]);
}
async function applyCode(player, input) {
  const code = codeFromInput(input);
  await ensureProfile(player);
  if (!storageConfig.hasDatabaseConfig()) return mutateLocal(async data => {
    const existing = data.referrals[player.id];
    const id = Object.keys(data.profiles).find(key => data.profiles[key].code === code);
    if (!id) throw new Error('Referral code was not found.');
    const referrer = await playerStore.readPlayer(id);
    if (id === player.id || (referrer?.walletAddress && referrer.walletAddress === player.walletAddress)) throw new Error('You cannot use your own referral code.');
    if (existing && existing.referrer !== id) throw new Error('A referral has already been applied to this account.');
    if (!existing) data.referrals[player.id] = { referrer: id, createdAt: new Date().toISOString() };
    data.profiles[player.id].dismissed = true;
    return { ok: true };
  });
  return database.withTransaction(async () => {
    const db = database.getPool();
    await db.query('SELECT player_id FROM battlecity_referral_profiles WHERE player_id=$1 FOR UPDATE', [player.id]);
    const found = await db.query(`SELECT p.player_id, u.wallet_address FROM battlecity_referral_profiles p JOIN battlecity_players u ON u.id=p.player_id WHERE p.code=$1`, [code]);
    if (!found.rowCount) throw new Error('Referral code was not found.');
    const referrer = found.rows[0];
    if (referrer.player_id === player.id || (referrer.wallet_address && referrer.wallet_address === player.walletAddress)) throw new Error('You cannot use your own referral code.');
    const existing = await db.query('SELECT referrer_player_id FROM battlecity_referrals WHERE referred_player_id=$1', [player.id]);
    if (existing.rowCount && existing.rows[0].referrer_player_id !== referrer.player_id) throw new Error('A referral has already been applied to this account.');
    await db.query('INSERT INTO battlecity_referrals(referred_player_id, referrer_player_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [player.id, referrer.player_id]);
    await db.query('UPDATE battlecity_referral_profiles SET prompt_dismissed=TRUE WHERE player_id=$1', [player.id]);
    return { ok: true };
  });
}
async function hasReferrer(playerId) {
  if (!storageConfig.hasDatabaseConfig()) return !!(await readLocal()).referrals[playerId];
  return (await database.getPool().query('SELECT 1 FROM battlecity_referrals WHERE referred_player_id=$1', [playerId])).rowCount > 0;
}
async function referrerCreatedAt(playerId) {
  if (!storageConfig.hasDatabaseConfig()) return (await readLocal()).referrals[playerId]?.createdAt || null;
  const result = await database.getPool().query('SELECT created_at FROM battlecity_referrals WHERE referred_player_id=$1', [playerId]);
  return result.rowCount ? new Date(result.rows[0].created_at).toISOString() : null;
}
async function accruePayment(record) {
  const amount = (BigInt(record.amountAtomic) / 100n).toString();
  if (!storageConfig.hasDatabaseConfig()) return mutateLocal(data => {
    const referral = data.referrals[record.playerId];
    if (!referral || Date.parse(referral.createdAt) > Date.parse(record.eligibleAt || record.confirmedAt)) return;
    if (!data.rewards[record.signature]) data.rewards[record.signature] = { referrer: referral.referrer, referred: record.playerId, currency: record.currency, network:record.network, mint:record.mint, tokenProgram:record.tokenProgram, decimals:record.decimals, amountAtomic: amount };
  });
  await database.getPool().query(`INSERT INTO battlecity_referral_rewards(payment_signature, referrer_player_id, referred_player_id, currency, amount_atomic, network, token_mint, token_program, decimals)
    SELECT $1, referrer_player_id, referred_player_id, $2, $3, $6, $7, $8, $9 FROM battlecity_referrals
    WHERE referred_player_id=$4 AND created_at <= $5 ON CONFLICT (payment_signature) DO NOTHING`,
    [record.signature, record.currency, amount, record.playerId, record.eligibleAt || record.confirmedAt, record.network, record.mint, record.tokenProgram, record.decimals]);
}
module.exports = { ensureProfile, dismissPrompt, applyCode, hasReferrer, referrerCreatedAt, accruePayment, codeFromInput, formatAmount };
