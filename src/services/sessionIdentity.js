const COOKIE_NAME = 'battlecity_session';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function resolveSession(cookieHeader) {
  const cookies = parseCookies(cookieHeader);
  const sessionId = cookies[COOKIE_NAME];

  return isValidSessionId(sessionId) ? sessionId : null;
}

function createSessionCookie(sessionId, origin = null) {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    'Path=/',
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    'HttpOnly',
    ...getCookieSecurityAttributes(origin),
  ]
    .join('; ');
}

function createClearedSessionCookie(origin = null) {
  return [
    `${COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    ...getCookieSecurityAttributes(origin),
  ]
    .join('; ');
}

function getCookieSecurityAttributes(origin) {
  if (process.env.NODE_ENV !== 'production') {
    return ['SameSite=Lax'];
  }

  if (isLocalDevelopmentOrigin(origin)) {
    return ['SameSite=None', 'Secure', 'Partitioned'];
  }

  return ['SameSite=Lax', 'Secure'];
}

function isLocalDevelopmentOrigin(origin) {
  if (typeof origin !== 'string' || origin === '') {
    return false;
  }

  try {
    const host = new URL(origin).hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    );
  } catch {
    return false;
  }
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (typeof cookieHeader !== 'string' || cookieHeader === '') {
    return cookies;
  }

  cookieHeader.split(';').forEach((part) => {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) {
      return;
    }

    const name = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    cookies[name] = decodeURIComponent(value);
  });

  return cookies;
}

function isValidSessionId(value) {
  return typeof value === 'string' && /^sess-[a-z0-9-]+$/i.test(value);
}

module.exports = {
  COOKIE_NAME,
  createClearedSessionCookie,
  createSessionCookie,
  resolveSession,
};
