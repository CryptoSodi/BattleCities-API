const store = require('../stores/competitionStore');
const economy = require('../stores/economyStore');
const skr = require('./skrToken');

function defaults() {
  return { seasonPass: { enabled: false, skrPrice: null, solPrice: null },
    cycle: { enabled: false, prizes: [] }, season: { enabled: false, prizes: [] },
    tradingSeason: { enabled: false, prizes: [] }, shopSkrPrices: {} };
}
async function get() { return await store.getSettings() || defaults(); }
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Settings must be an object.');
  const token = skr.config();
  const value = defaults();
  const pass = input.seasonPass;
  if (!pass || typeof pass.enabled !== 'boolean') throw new Error('seasonPass.enabled must be a boolean.');
  value.seasonPass = { enabled: pass.enabled, skrPrice: price(pass.skrPrice, token?.decimals ?? 9), solPrice: price(pass.solPrice, 9) };
  if (pass.enabled && (!token || !value.seasonPass.skrPrice || !value.seasonPass.solPrice)) {
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
  return value;
}
function price(value, decimals) {
  if (value === null || value === undefined) return null;
  skr.atomic(value, decimals);
  return String(value);
}
async function update(input, adminId) {
  const value = validate(input);
  return store.saveSettings(value, adminId);
}
module.exports = { defaults, get, validate, update };
