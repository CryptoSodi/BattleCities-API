const COOKIE_NAME = 'battlecity_replay_guest';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function resolveReplayGuest(cookieHeader) {
  const cookies = parseCookies(cookieHeader);
  const existingGuestId = cookies[COOKIE_NAME];

  if (isValidGuestId(existingGuestId)) {
    return {
      guestId: existingGuestId,
      setCookie: null,
    };
  }

  const guestId = createGuestId();
  return {
    guestId,
    setCookie: createCookie(guestId),
  };
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

function createCookie(guestId) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';

  return [
    `${COOKIE_NAME}=${encodeURIComponent(guestId)}`,
    'Path=/',
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    'SameSite=Lax',
    'HttpOnly',
    secure,
  ]
    .filter(Boolean)
    .join('; ');
}

function createGuestId() {
  return `guest-${Date.now().toString(36)}-${Math.floor(
    Math.random() * 0xffffff,
  ).toString(36)}`;
}

function isValidGuestId(value) {
  return typeof value === 'string' && /^guest-[a-z0-9-]+$/i.test(value);
}

module.exports = {
  COOKIE_NAME,
  resolveReplayGuest,
};
