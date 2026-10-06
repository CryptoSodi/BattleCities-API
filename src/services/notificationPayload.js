const ROUTES = new Set(['home', 'play', 'shop', 'rewards', 'social', 'external', 'share']);
const TYPES = new Set(['announcement', 'reward', 'event', 'social', 'share']);

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_NOTIFICATION';
  return error;
}

function text(value, label, limit, required = false) {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw invalid(`${label} must be text`);
  }
  const result = (value || '').trim();
  if (required && !result) throw invalid(`${label} is required`);
  if (result.length > limit) throw invalid(`${label} must be ${limit} characters or fewer`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) {
    throw invalid(`${label} contains invalid characters`);
  }
  return result;
}

function httpsUrl(value, label, required = false) {
  const result = text(value, label, 2048, required);
  if (!result) return '';
  try {
    const url = new URL(result);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error();
    if (url.href.length > 2048) throw new Error();
    return url.href;
  } catch {
    throw invalid(`${label} must be a valid HTTPS URL without credentials`);
  }
}

function normalizeNotification(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('A notification is required');
  const requestedRoute = text(input.route, 'Route', 32) || 'home';
  const route = ROUTES.has(requestedRoute) ? requestedRoute : 'home';
  const type = text(input.type, 'Type', 32) || 'announcement';
  if (!TYPES.has(type)) throw invalid('Choose a valid notification type');
  const data = {
    title: text(input.title, 'Title', 80, true),
    // The existing admin dashboard calls this field "message".
    body: text(input.body === undefined ? input.message : input.body, 'Message', 240, true),
    route,
    type,
  };
  const optional = {
    imageUrl: httpsUrl(input.imageUrl, 'Image URL'),
    externalUrl: httpsUrl(input.externalUrl, 'External link', route === 'external'),
    actionLabel: text(input.actionLabel, 'Action label', 32),
  };
  for (const [key, value] of Object.entries(optional)) if (value) data[key] = value;
  // A conservative bound also includes JSON syntax and UTF-8 multibyte text.
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 4096) throw invalid('Notification data exceeds 4096 bytes');
  return data;
}

function isValidToken(value) {
  return typeof value === 'string' && value.length >= 20 && value.length <= 2048
    && /^[A-Za-z0-9_:./+=-]+$/.test(value);
}

module.exports = { normalizeNotification, isValidToken };
