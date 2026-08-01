import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { loadLocalEnv } = require('../src/config/loadLocalEnv');

loadLocalEnv();

const googleAuth = require('../src/services/googleAuth');
const storageConfig = require('../src/config/storageConfig');

const databaseUrl = storageConfig.getDatabaseUrl();
const database = describeDatabase(databaseUrl);
const embeddedBroadcaster = isEnabled('BATTLECITY_EMBED_BROADCASTER');
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
  webBaseUrl: process.env.BATTLECITY_WEB_BASE_URL || '(same origin)',
  blob: {
    configured: isConfigured('BLOB_READ_WRITE_TOKEN'),
  },
  broadcaster: {
    configured:
      isConfigured('BROADCASTER_BASE_URL') &&
      (embeddedBroadcaster || isConfigured('BROADCASTER_SERVICE_TOKEN')),
    embedded: embeddedBroadcaster,
    baseUrl: process.env.BROADCASTER_BASE_URL || null,
    serviceToken: isConfigured('BROADCASTER_SERVICE_TOKEN')
      ? 'configured'
      : embeddedBroadcaster
        ? 'generated at startup'
        : 'missing',
  },
};

console.log(JSON.stringify(status, null, 2));

if (
  !status.postgres.configured ||
  !status.google.configured ||
  !status.broadcaster.configured
) {
  process.exitCode = 1;
}

function isConfigured(name) {
  return String(process.env[name] || '').trim() !== '';
}

function isEnabled(name) {
  return ['1', 'true', 'yes'].includes(
    String(process.env[name] || '').trim().toLowerCase(),
  );
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
