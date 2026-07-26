import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { loadLocalEnv } = require('../src/config/loadLocalEnv');

loadLocalEnv();

const googleAuth = require('../src/services/googleAuth');
const storageConfig = require('../src/config/storageConfig');

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
  webBaseUrl: process.env.BATTLECITY_WEB_BASE_URL || '(same origin)',
  blob: {
    configured: isConfigured('BLOB_READ_WRITE_TOKEN'),
  },
};

console.log(JSON.stringify(status, null, 2));

if (!status.postgres.configured || !status.google.configured) {
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
