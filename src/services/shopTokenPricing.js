const skr = require('./skrToken');
const play = require('./playToken');
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TTL = 10 * 60 * 1000;
let cached, pending;
let nextFetchAt = 0;
const derived = new Map();
function fraction(value) {
  const text = String(value), m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!m || text.length > 64) throw new Error('Invalid market amount.');
  const exponent = Number(m[3] || 0) - (m[2] || '').length;
  if (Math.abs(exponent) > 40) throw new Error('Unsupported market precision.');
  let numerator = BigInt(m[1] + (m[2] || '')), denominator = 1n;
  if (exponent >= 0) numerator *= 10n ** BigInt(exponent); else denominator = 10n ** BigInt(-exponent);
  if (numerator <= 0n) throw new Error('Amounts must be positive.');
  return { numerator, denominator };
}
// One process-wide, single-flight batch per ten minutes, shared by all players.
async function market() {
  if (cached && Date.now() < cached.expiresAt) return cached;
  if (pending) return pending;
  if (Date.now() < nextFetchAt) throw new Error('Market pricing is unavailable until the next shared refresh.');
  nextFetchAt = Date.now() + TTL;
  pending = (async () => {
    const token = skr.requireConfig(); play.requireConfig();
    const key = String(process.env.JUPITER_API_KEY || '');
    const response = await fetch('https://api.jup.ag/price/v3?ids=' + SOL_MINT + ',' + token.mint + ',' + play.MINT, {
      headers: key ? { 'x-api-key': key } : {}, redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Token market pricing is temporarily unavailable.');
    const text = await response.text(); if (text.length > 65536) throw new Error('Invalid market response.');
    const data = JSON.parse(text), prices = [data[SOL_MINT], data[token.mint], data[play.MINT]];
    const valid = p => p && Number.isFinite(p.usdPrice) && p.usdPrice > 0;
    if (!valid(prices[0]) || (!valid(prices[1]) && !valid(prices[2]))) throw new Error('Reliable market pricing is unavailable.');
    prices.filter(valid).forEach(p => fraction(p.usdPrice));
    const fetchedAt = Date.now();
    cached = { source: 'jupiter-price-v3', solUsd: String(prices[0].usdPrice), skrUsd: valid(prices[1])?String(prices[1].usdPrice):null,
      playUsd: valid(prices[2])?String(prices[2].usdPrice):null, fetchedAt, expiresAt: fetchedAt + TTL, refreshSeconds: 600,
      solBlockId: prices[0].blockId, skrBlockId: prices[1]?.blockId, playBlockId: prices[2]?.blockId };
    return cached;
  })();
  try { return await pending; } finally { pending = null; }
}
function convertSol(amount, currency, rate) {
  if (!rate || Date.now() >= rate.expiresAt) throw new Error('Market price expired.');
  if (!['skr', 'play'].includes(currency)) throw new Error('Invalid shop token.');
  const value = fraction(amount), sol = fraction(rate.solUsd), token = fraction(rate[currency + 'Usd']);
  const decimals = currency === 'skr' ? skr.requireConfig().decimals : play.requireConfig().decimals;
  const unit = 10n ** BigInt(decimals);
  // Exact rational arithmetic: 80% of the SOL value, rounded up to one atomic unit.
  const n = value.numerator * sol.numerator * token.denominator * 80n * unit;
  const d = value.denominator * sol.denominator * token.numerator * 100n;
  const atomic = (n + d - 1n) / d;
  if (atomic <= 0n || atomic > 18446744073709551615n) throw new Error('Token amount is out of range.');
  const whole = (atomic / unit).toString(), tail = decimals ? (atomic % unit).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return whole + (tail ? '.' + tail : '');
}
async function price(settings, id, currency, solPrice, rate = null) {
  if (currency === 'play') play.requireConfig();
  if (settings.tokenPricingMode !== 'sol-discounted') {
    return currency === 'play' ? settings.shopPlayPrices?.[id] ?? null
      : id === 'season-pass' ? settings.seasonPass.skrPrice : settings.shopSkrPrices[id] ?? null;
  }
  if (currency === 'skr') skr.requireConfig();
  const overrides = currency === 'skr' ? settings.shopSkrOverrides || {} : settings.shopPlayPrices || {};
  if (Object.hasOwn(overrides, id)) return overrides[id];
  if (solPrice == null) return null;
  const snapshot = rate || await market();
  if (Date.now() >= snapshot.expiresAt) throw new Error('Market price expired.');
  const key = [snapshot.fetchedAt, snapshot.solUsd, snapshot[currency + 'Usd'], currency, solPrice].join('|');
  if (!derived.has(key)) {
    if (derived.size >= 256) derived.clear();
    derived.set(key, convertSol(solPrice, currency, snapshot));
  }
  return derived.get(key);
}
module.exports = { market, convertSol, price, fraction, SOL_MINT };
