const crypto = require('crypto');

const COOKIE_NAME = 'battlecity_presence';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function createVisitorId() {
  return `visitor-${crypto.randomBytes(16).toString('hex')}`;
}

function resolveVisitorId(cookieHeader) {
  if (typeof cookieHeader !== 'string' || cookieHeader === '') {
    return null;
  }

  for (const part of cookieHeader.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const name = part.slice(0, separatorIndex).trim();
    if (name !== COOKIE_NAME) {
      continue;
    }

    try {
      const value = decodeURIComponent(part.slice(separatorIndex + 1).trim());
      return isValidVisitorId(value) ? value : null;
    } catch {
      return null;
    }
  }

  return null;
}

function createPresenceCookie(visitorId, origin = null) {
  const attributes = [
    `${COOKIE_NAME}=${encodeURIComponent(visitorId)}`,
    'Path=/',
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    'HttpOnly',
  ];
  if (requiresPartitionedCookie(origin)) {
    attributes.push('SameSite=None', 'Secure', 'Partitioned');
  } else {
    attributes.push('SameSite=Lax');
    if (process.env.NODE_ENV === 'production') {
      attributes.push('Secure');
    }
  }
  return attributes.join('; ');
}

function requiresPartitionedCookie(origin) {
  if (typeof origin !== 'string' || origin === '') {
    return false;
  }

  try {
    const host = new URL(origin).hostname.toLowerCase();
    return (
      host === 'cryptosodi.github.io' ||
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1'
    );
  } catch {
    return false;
  }
}

function isValidVisitorId(value) {
  return typeof value === 'string' && /^visitor-[a-f0-9]{32}$/.test(value);
}

module.exports = {
  COOKIE_NAME,
  createPresenceCookie,
  createVisitorId,
  resolveVisitorId,
};
