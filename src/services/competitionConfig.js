const store = require('../stores/competitionStore');
const economy = require('../stores/economyStore');
const skr = require('./skrToken');
const solanaNetwork = require('../config/solanaNetwork');

const DEVNET_SHOP_SKR_PRICES = Object.freeze({
  'fuel-one': '150',
  'fuel-five': '600',
  'fuel-twenty': '1800',
  shield: '300',
  'base-defence': '375',
  freeze: '450',
  speed: '450',
  upgrade: '675',
  'zoom-out': '375',
  wipeout: '600',
  'extra-life': '525',
  'max-healer': '450', 'health-healer': '450',
  'rapid-shooter': '450', 'rapid-shooter-long': '900',
  'starter-pack': '1200',
});

const SHOP_IDS = Object.keys(DEVNET_SHOP_SKR_PRICES);

function isDevnet() {
  return solanaNetwork.network() === 'devnet';
}

function defaults() {
  return { seasonPass: { enabled: false, skrPrice: null, solPrice: null },
    cycle: { enabled: false, prizes: [] }, season: { enabled: false, prizes: [] },
    tradingSeason: { enabled: false, prizes: [] },
    shopSolPrices: Object.fromEntries(SHOP_IDS.map(id => [id, String(economy.getShopCatalogItem(id).solPrice)])),
    shopPlayPrices: {}, shopSkrOverrides: {}, tokenPricingMode: 'fixed',
    shopSkrPrices: isDevnet() ? { ...DEVNET_SHOP_SKR_PRICES } : { 'max-healer': '450', 'health-healer': '450', 'rapid-shooter': '450', 'rapid-shooter-long': '900' } };
}

async function get() {
  const stored = await store.getSettings();
  const value = defaults();
  if (!stored) return value;

  const storedPrices = stored.shopSkrPrices && typeof stored.shopSkrPrices === 'object'
    ? stored.shopSkrPrices : {};
  const hasConfiguredShopPrice = Object.values(storedPrices).some((amount) => amount !== null && amount !== undefined);
  return {
    ...value,
    ...stored,
    seasonPass: { ...value.seasonPass, ...(stored.seasonPass || {}) },
    cycle: { ...value.cycle, ...(stored.cycle || {}) },
    season: { ...value.season, ...(stored.season || {}) },
    tradingSeason: { ...value.tradingSeason, ...(stored.tradingSeason || {}) },
    shopSolPrices: { ...value.shopSolPrices, ...(stored.shopSolPrices || {}) },
    shopPlayPrices: { ...(stored.shopPlayPrices || {}) },
    shopSkrOverrides: { ...(stored.shopSkrOverrides || {}) },
    shopSkrPrices: {
      ...value.shopSkrPrices,
      ...(isDevnet() && !hasConfiguredShopPrice ? {} : storedPrices),
    },
  };
}

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Settings must be an object.');
  const token = skr.config();
  const value = defaults();
  const pass = input.seasonPass;
  if (!pass || typeof pass.enabled !== 'boolean') throw new Error('seasonPass.enabled must be a boolean.');
  value.seasonPass = { enabled: pass.enabled, skrPrice: price(pass.skrPrice, token?.decimals ?? 9), solPrice: price(pass.solPrice, 9) };
  if (pass.enabled && (!token || !value.seasonPass.solPrice || (input.tokenPricingMode !== 'sol-discounted' && !value.seasonPass.skrPrice))) {
    throw new Error('Configure SKR and both season pass prices before enabling sales.');
  }
  for (const name of ['cycle', 'season', 'tradingSeason']) {
    const policy = input[name];
    if (!policy || typeof policy.enabled !== 'boolean' || !Array.isArray(policy.prizes) || policy.prizes.length > 100) {
      throw new Error(`${name} must contain enabled and a prizes array.`);
    }
    const used = new Set();
    value[name] = { enabled: policy.enabled, prizes: policy.prizes.map((tier) => {
      if (!Number.isInteger(tier.fromRank) || !Number.isInteger(tier.toRank)
        || tier.fromRank < 1 || tier.toRank < tier.fromRank || tier.toRank > (name === 'cycle' ? 10 : 100)) throw new Error('Invalid prize rank range.');
      for (let rank = tier.fromRank; rank <= tier.toRank; rank++) {
        if (used.has(rank)) throw new Error('Prize rank ranges overlap.');
        used.add(rank);
      }
      const amount = price(tier.amount, token?.decimals ?? 9);
      if (!amount) throw new Error('Prize amounts must be positive.');
      return { fromRank: tier.fromRank, toRank: tier.toRank, amount };
    }) };
    if (policy.enabled && (!token || !policy.prizes.length)) throw new Error('Configure SKR and prizes before enabling payouts.');
  }
  if (!input.shopSkrPrices || typeof input.shopSkrPrices !== 'object' || Array.isArray(input.shopSkrPrices)) throw new Error('shopSkrPrices must be an object.');
  for (const [id, amount] of Object.entries(input.shopSkrPrices)) {
    if (!economy.getShopCatalogItem(id)) throw new Error(`Unknown shop item: ${id}`);
    value.shopSkrPrices[id] = price(amount, token?.decimals ?? 9);
  }
  if (input.tokenPricingMode !== undefined && !['fixed', 'sol-discounted'].includes(input.tokenPricingMode)) throw new Error('Invalid token pricing mode.');
  value.tokenPricingMode = input.tokenPricingMode ?? 'fixed';
  for (const [field, decimals] of [['shopSolPrices', 9], ['shopPlayPrices', 6], ['shopSkrOverrides', token?.decimals ?? 6]]) {
    const prices = input[field] ?? {};
    if (!prices || typeof prices !== 'object' || Array.isArray(prices)) throw new Error(`${field} must be an object.`);
    for (const [id, amount] of Object.entries(prices)) {
      if (!economy.getShopCatalogItem(id) && !(field !== 'shopSolPrices' && id === 'season-pass')) throw new Error(`Unknown shop item: ${id}`);
      value[field][id] = price(amount, decimals);
    }
  }
  return value;
}

function price(value, decimals) {
  if (value === null || value === undefined) return null;
  skr.atomic(value, decimals);
  return String(value);
}

async function update(input, adminId) {
  const current = await get();
  const value = validate({ ...current, ...input });
  return store.saveSettings(value, adminId);
}

module.exports = { defaults, get, validate, update };
