const environment = String(process.env.VERCEL_ENV || '').toLowerCase();

if (environment === 'production') {
  console.log('[battlecities-api] running production deployment migrations');
  await import('./migrate.mjs');
} else {
  console.log(
    `[battlecities-api] skipping deployment migrations for ${
      environment || 'unknown'
    } environment`,
  );
}
