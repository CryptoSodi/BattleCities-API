import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../src/config/loadLocalEnv').loadLocalEnv();
const storage = require('../src/config/storageConfig');
const configured = (name) => String(process.env[name] || '').trim() !== '';
const status = {
  storage: { postgres: storage.hasDatabaseConfig(), local: !storage.isProductionRuntime() && !storage.hasDatabaseConfig() },
  login: { providers: ['guest', 'wallet'] },
  shop: { treasuryOverride: configured('BATTLECITY_SHOP_TREASURY_ADDRESS'), quoteSecret: configured('BATTLECITY_SHOP_QUOTE_SECRET') },
  skr: { mint: configured('BATTLECITY_SKR_MINT'), decimals: configured('BATTLECITY_SKR_DECIMALS') },
  social: { x: require('../src/services/xOAuth').isConfigured(), discord: configured('DISCORD_CLIENT_ID') && configured('DISCORD_CLIENT_SECRET') },
  notifications: { firebase: require('../src/services/firebaseMessaging').isConfigured() },
  competitions: { deliveryEnabled: process.env.BATTLECITY_LEADERBOARD_REWARDS_ENABLED === '1' },
};
console.log(JSON.stringify(status, null, 2));
if (!status.storage.postgres && !status.storage.local) process.exitCode = 1;
