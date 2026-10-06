const store = require('../stores/competitionStore');
const settings = require('./competitionConfig');
const seasons = require('../stores/seasonStore');
const matches = require('../stores/matchResultStore');
const trading = require('../stores/tradingStore');
const skr = require('./skrToken');
const INTERVAL_MS = 30 * 60 * 1000;
// Allow an in-flight pass checkout to finish before freezing season results.
const CLOSE_GRACE_MS = 5 * 60 * 1000;
const noPrizes = () => ({ enabled: false, prizes: [], token: null });

function cycleAt(at = Date.now()) {
  const start = Math.floor(at / INTERVAL_MS) * INTERVAL_MS;
  return { id: `cycle:${start}`, kind: 'cycle', scope: 'gaming', seasonId: null,
    startsAt: new Date(start).toISOString(), endsAt: new Date(start + INTERVAL_MS).toISOString() };
}
function policy(value) { return { ...value, token: skr.config() }; }
async function ensureCurrent(now = Date.now()) {
  const config = await settings.get();
  const season = await seasons.getCurrentSeason();
  const cycle = await store.ensurePeriod({ ...cycleAt(now), policy: policy(config.cycle) });
  for (const scope of ['gaming', 'trading']) await store.ensurePeriod({
    id: `season:${scope}:${season.id}`, kind: 'season', scope, seasonId: season.id,
    startsAt: season.startsAt, endsAt: season.endsAt,
    policy: policy(scope === 'gaming' ? config.season : config.tradingSeason),
  });
  return cycle;
}
async function board(period, acceptedOnly = false) {
  if (period.kind === 'cycle') return matches.getLeaderboardInWindow(null, period.startsAt, period.endsAt, 100, null, acceptedOnly);
  if (period.scope === 'trading') return trading.getLeaderboard(period.startsAt, period.endsAt, 100, null, acceptedOnly);
  return matches.getLeaderboard(period.seasonId, 100, acceptedOnly);
}
function allocations(period, rows) {
  if (!period.policy.enabled || !period.policy.token) return [];
  return rows.flatMap((row) => {
    const tier = period.policy.prizes.find((p) => row.rank >= p.fromRank && row.rank <= p.toRank);
    if (!tier) return [];
    skr.atomic(tier.amount, period.policy.token.decimals);
    return [{ id: `${period.id}:${String(row.rank).padStart(3, '0')}`, periodId: period.id,
      playerId: row.playerId, walletAddress: row.walletAddress || null, rank: row.rank,
      amount: tier.amount, tokenConfig: period.policy.token,
      status: row.walletAddress ? 'pending' : 'wallet_required' }];
  });
}
async function close(period, now = Date.now()) {
  if (period.closedAt) return period;
  if (Date.parse(period.endsAt) + CLOSE_GRACE_MS > now) return period;
  const rows = await board(period);
  const eligible = await board(period, true);
  return store.closePeriod(period.id, rows, allocations(period, eligible));
}
async function historicalCycle(id, now = Date.now()) {
  if (!/^cycle:\d{10,16}$/.test(id)) throw new Error('Invalid cycle id.');
  const start = Number(id.slice(6));
  if (!Number.isSafeInteger(start) || start % INTERVAL_MS !== 0 || start + INTERVAL_MS > now || start < Date.UTC(2020, 0, 1)) {
    throw new Error('Cycle must be a completed 30-minute interval.');
  }
  let period = await store.getPeriod(id);
  const allSeasons = await seasons.listSeasons();
  const first = allSeasons.length ? Math.floor(Math.min(...allSeasons.map((s) => Date.parse(s.startsAt))) / INTERVAL_MS) * INTERVAL_MS : now;
  if (!period && start < first) throw new Error('Cycle predates recorded seasons.');
  // Historical imports provide standings, never retroactive unapproved payouts.
  if (!period) period = await store.ensurePeriod({ ...cycleAt(start), policy: noPrizes() });
  return close(period, now);
}
async function listCycles(before = Date.now(), limit = 20) {
  const allSeasons = await seasons.listSeasons();
  const first = allSeasons.length ? Math.min(...allSeasons.map((s) => Date.parse(s.startsAt))) : Date.now();
  let at = Math.floor(Math.min(Date.now(), before) / INTERVAL_MS) * INTERVAL_MS - INTERVAL_MS;
  const items = [];
  for (let i = 0; i < limit && at >= first; i++, at -= INTERVAL_MS) {
    const descriptor = cycleAt(at);
    const saved = await store.getPeriod(descriptor.id);
    items.push({ ...descriptor, archived: !!saved?.closedAt, payoutEnabled: saved?.policy.enabled || false });
  }
  return { items, nextBefore: items.length === limit ? items[items.length - 1].startsAt : null };
}
function publicPayout(p) {
  return { id: p.id, periodId: p.periodId, playerId: p.playerId, walletAddress: p.walletAddress,
    rank: p.rank, amount: p.amount, currency: 'SKR', status: p.status,
    signature: p.delivery?.signature || null, paidAt: p.paidAt, createdAt: p.createdAt };
}
let running = false;
let payoutCursor = null;
async function tick(now = Date.now()) {
  if (running) return;
  running = true;
  try {
    await ensureCurrent(now);
    for (const period of await store.listPeriods({ open: true, limit: 100 })) await close(period, now);
    if (process.env.BATTLECITY_LEADERBOARD_REWARDS_ENABLED === '1') {
      const delivery = require('./rankingPayoutDelivery');
      const batch = await store.listPayouts({ pending: true, limit: 25, before: payoutCursor });
      payoutCursor = batch.length === 25 ? batch[batch.length - 1].id : null;
      for (const payout of batch) {
        try { await delivery.deliver(payout.id); }
        catch { console.warn('[battlecities-api] payout retry pending', payout.id); }
      }
    }
  } finally { running = false; }
}
function startWorker() {
  // The deployment opt-in prevents migrations/tests from starting a payment worker.
  if (process.env.BATTLECITY_COMPETITIONS_WORKER_ENABLED !== '1') return () => {};
  const run = () => tick().catch(() => console.error('[battlecities-api] competition worker failed'));
  run(); const timer = setInterval(run, 30000); timer.unref();
  return () => clearInterval(timer);
}
module.exports = { INTERVAL_MS, CLOSE_GRACE_MS, cycleAt, ensureCurrent, board, allocations,
  close, historicalCycle, listCycles, publicPayout, tick, startWorker };
