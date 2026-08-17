import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { loadLocalEnv } = require('../src/config/loadLocalEnv');

loadLocalEnv();

const googleAuth = require('../src/services/googleAuth');
const storageConfig = require('../src/config/storageConfig');
const presaleService = require('../src/services/presaleService');

const databaseUrl = storageConfig.getDatabaseUrl();
const database = describeDatabase(databaseUrl);
const status = {
  postgres: {
    configured: databaseUrl !== '',
    host: database.host,
    database: database.name,
  },
  google: {
    configured: googleAuth.isConfigured(),
    clientId: isConfigured('GOOGLE_CLIENT_ID'),
    clientSecret: isConfigured('GOOGLE_CLIENT_SECRET'),
    stateSecret: isConfigured('GOOGLE_OAUTH_STATE_SECRET'),
  },
  cherry: {
    configured:
      isConfigured('CHERRY_APP_ID') && isConfigured('CHERRY_APP_SECRET'),
    appId: isConfigured('CHERRY_APP_ID') ? 'configured' : 'missing',
    appSecret: isConfigured('CHERRY_APP_SECRET') ? 'configured' : 'missing',
  },
  webBaseUrl: process.env.BATTLECITY_WEB_BASE_URL || '(same origin)',
  blob: {
    configured: isConfigured('BLOB_READ_WRITE_TOKEN'),
  },
  broadcaster: {
    configured:
      isConfigured('WEBSOCKET_BROADCASTER_BASE_URL') &&
      isConfigured('BROADCASTER_SERVICE_TOKEN'),
    baseUrl: process.env.WEBSOCKET_BROADCASTER_BASE_URL || null,
    serviceToken: isConfigured('BROADCASTER_SERVICE_TOKEN')
      ? 'configured'
      : 'missing',
  },
  presale: {
    configured: presaleService.isConfigured(),
    network: process.env.BATTLECITY_PRESALE_NETWORK || null,
    treasury: isConfigured('BATTLECITY_PRESALE_TREASURY_ADDRESS'),
      tokenMint: isConfigured('BATTLECITY_PRESALE_TOKEN_MINT'),
      distributionAddress: isConfigured('BATTLECITY_PRESALE_DISTRIBUTION_ADDRESS'),
      distributionKeypairPath: isConfigured('BATTLECITY_PRESALE_DISTRIBUTION_KEYPAIR_PATH'),
    pythApiKey: isConfigured('BATTLECITY_PRESALE_PYTH_API_KEY'),
    quoteSecret: isConfigured('BATTLECITY_PRESALE_QUOTE_SECRET'),
  },
};

console.log(JSON.stringify(status, null, 2));

if (
  !status.postgres.configured ||
  !status.google.configured ||
  !status.cherry.configured ||
  !status.broadcaster.configured ||
  !status.presale.configured
) {
  process.exitCode = 1;
}

function isConfigured(name) {
  return String(process.env[name] || '').trim() !== '';
}

function describeDatabase(value) {
  if (value === '') {
    return { host: null, name: null };
  }
  try {
    const url = new URL(value);
    return {
      host: url.hostname,
      name: url.pathname.replace(/^\//, '') || null,
    };
  } catch {
    return { host: '(invalid URL)', name: null };
  }
}
