declare const require: any;
import { createJsonResponse, createOptionsResponse, resolveSessionPlayer } from '../_helpers';
const settings = require('../../services/competitionConfig');
const seasons = require('../../stores/seasonStore');
const competitions = require('../../stores/competitionStore');
const economy = require('../../stores/economyStore');
const skr = require('../../services/skrToken');

export function OPTIONS(request: Request): Response { return createOptionsResponse(request); }
export async function GET(request: Request): Promise<Response> {
  const config = await settings.get();
  const season = await seasons.getCurrentSeason();
  const player = await resolveSessionPlayer(request);
  const pass = player ? await competitions.getPass(player.id, season.id) : null;
  const itemIds = ['fuel-one','fuel-five','fuel-twenty','shield','base-defence','freeze','speed',
    'upgrade','zoom-out','wipeout','extra-life','starter-pack'];
  return createJsonResponse(request, {
    currency: { skr: skr.config(), sol: { decimals: 9, network: 'mainnet-beta' } },
    items: itemIds.map((id) => { const item = economy.getShopCatalogItem(id); return {
      id, solPrice: String(item.solPrice), skrPrice: config.shopSkrPrices[id] ?? null,
      fuel: item.fuel || 0, inventory: item.inventory || {},
    }; }),
    seasonPass: { id: 'season-pass', tab: 'SEASON PASS', season: seasons.toPublicSeason(season),
      enabled: config.seasonPass.enabled, prices: { skr: config.seasonPass.skrPrice, sol: config.seasonPass.solPrice },
      owned: !!pass, eligibleFrom: pass?.eligibleFrom || null, expiresAt: pass?.expiresAt || season.endsAt,
      scoringPolicy: 'all_matches_in_season',
      purchaseAvailable: config.seasonPass.enabled && !pass && Date.parse(season.endsAt) - Date.now() > 180000 },
  });
}
