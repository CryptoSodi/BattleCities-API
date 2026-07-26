function normalizeEnv(value) {
  return String(value || '').trim().toLowerCase();
}

function isLocalStorageForced() {
  const mode = normalizeEnv(process.env.BATTLECITY_STORAGE_MODE);
  const forceLocal = normalizeEnv(process.env.BATTLECITY_FORCE_LOCAL_STORE);

  return (
    mode === 'local' ||
    forceLocal === '1' ||
    forceLocal === 'true' ||
    forceLocal === 'yes'
  );
}

function isProductionRuntime() {
  const nodeEnv = normalizeEnv(process.env.NODE_ENV);
  const vercelEnv = normalizeEnv(process.env.VERCEL_ENV);
  return nodeEnv === 'production' || vercelEnv === 'production';
}

function assertStorageModeAllowed() {
  if (!isProductionRuntime()) {
    return;
  }

  if (isLocalStorageForced()) {
    throw new Error('Local JSON storage is disabled in production');
  }

  if (resolveDatabaseUrl() === '') {
    throw new Error('DATABASE_URL is required in production');
  }
}

function resolveDatabaseUrl() {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    ''
  );
}

function getDatabaseUrl() {
  assertStorageModeAllowed();
  if (isLocalStorageForced()) {
    return '';
  }

  return resolveDatabaseUrl();
}

function hasDatabaseConfig() {
  return getDatabaseUrl() !== '';
}

module.exports = {
  assertStorageModeAllowed,
  getDatabaseUrl,
  hasDatabaseConfig,
  isLocalStorageForced,
  isProductionRuntime,
};
