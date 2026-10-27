declare const require: any;
import { createJsonResponse, createOptionsResponse, resolveSessionPlayer } from '../_helpers';
const settings = require('../../services/competitionConfig');
const seasons = require('../../stores/seasonStore');
const competitions = require('../../stores/competitionStore');
const economy = require('../../stores/economyStore');
const skr = require('../../services/skrToken');
const solanaNetwork = require('../../config/solanaNetwork');
const play = require('../../services/playToken');
const tokenPricing = require('../../services/shopTokenPricing');

export function OPTIONS(request: Request): Response { return createOptionsResponse(request); }
export async function GET(request: Request): Promise<Response> {
  const config = await settings.get();
  const season = await seasons.getCurrentSeason();
  const player = await resolveSessionPlayer(request);
  const pass = player ? await competitions.getPass(player.id, season.id) : null;
  const itemIds = ['fuel-one','fuel-five','fuel-twenty','shield','base-defence','freeze','speed',
    'upgrade','zoom-out','wipeout','extra-life','max-healer','health-healer','rapid-shooter','rapid-shooter-long','starter-pack'];
  let rate = null, pricingStatus = config.tokenPricingMode === 'sol-discounted' ? 'unavailable' : 'fixed';
  if (config.tokenPricingMode === 'sol-discounted') {
    try { rate = await tokenPricing.market(); pricingStatus = 'available'; } catch { /* SOL remains usable without token pricing. */ }
  }
  const tokenPrice = async (id: string, currency: string, amount: string | null) => {
    const overrides = currency === 'skr' ? config.shopSkrOverrides : config.shopPlayPrices;
    if (config.tokenPricingMode === 'sol-discounted' && !rate && !Object.prototype.hasOwnProperty.call(overrides || {}, id)) return null;
    try { return await tokenPricing.price(config, id, currency, amount, rate); } catch { return null; }
  };
  const rows = await Promise.all(itemIds.map(async (id) => { const item = economy.getShopCatalogItem(id); return {
    id, solPrice: config.shopSolPrices[id] ?? null, skrPrice: await tokenPrice(id, 'skr', config.shopSolPrices[id]),
    playPrice: await tokenPrice(id, 'play', config.shopSolPrices[id]),
    fuel: item.fuel || 0, inventory: item.inventory || {},
  }; }));
  return createJsonResponse(request, {
    currency: { skr: skr.config(), play: play.config(), sol: { decimals: 9, network: solanaNetwork.network() } },
    tokenPricing: { mode: config.tokenPricingMode, discountPercent: 20, refreshSeconds: 600, status: pricingStatus, market: rate },
    items: rows,
    seasonPass: { id: 'season-pass', tab: 'SEASON PASS', season: seasons.toPublicSeason(season),
      enabled: config.seasonPass.enabled, prices: { skr: await tokenPrice('season-pass', 'skr', config.seasonPass.solPrice), sol: config.seasonPass.solPrice,
        play: await tokenPrice('season-pass', 'play', config.seasonPass.solPrice) },
      owned: !!pass, eligibleFrom: pass?.eligibleFrom || null, expiresAt: pass?.expiresAt || season.endsAt,
      scoringPolicy: 'all_matches_in_season',
      purchaseAvailable: config.seasonPass.enabled && !pass && Date.parse(season.endsAt) - Date.now() > 180000 },
  });
}
