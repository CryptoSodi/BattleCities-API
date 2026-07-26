// Minimal in-memory sliding-window rate limiter (Milestone 7: "Add rate
// limits for tx verification and match submit"). Per-process only — good
// enough for the dev server and for single-instance serverless warm starts;
// a shared store (Redis/Postgres) can replace the Map when real value is at
// stake without changing call sites.

const buckets = new Map();

const LIMITS = {
  'matches-submit': { max: 10, windowMs: 60 * 1000 },
  'swap-verify': { max: 20, windowMs: 60 * 1000 },
  'quest-claim': { max: 20, windowMs: 60 * 1000 },
  'staking-action': { max: 20, windowMs: 60 * 1000 },
};

// Returns true when the call is allowed; false when the caller should get 429.
function allow(bucketName, key) {
  const limit = LIMITS[bucketName];
  if (limit === undefined) {
    return true;
  }

  const now = Date.now();
  const bucketKey = `${bucketName}:${key}`;
  const timestamps = (buckets.get(bucketKey) || []).filter(
    (timestamp) => now - timestamp < limit.windowMs,
  );

  if (timestamps.length >= limit.max) {
    buckets.set(bucketKey, timestamps);
    return false;
  }

  timestamps.push(now);
  buckets.set(bucketKey, timestamps);

  // Opportunistic cleanup so long-lived processes don't accumulate keys.
  if (buckets.size > 10000) {
    buckets.clear();
  }

  return true;
}

module.exports = { allow };
