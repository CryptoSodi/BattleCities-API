const BASE_URL = 'https://api.twitterapi.io';
const BATTLECITIES_USERNAME = 'BattleCitiesHQ';

function isConfigured() {
  return String(process.env.TWITTERAPI_IO_KEY || '').trim() !== '';
}

async function checkFollowRelationship(sourceUsername) {
  const body = await request('/twitter/user/check_follow_relationship', {
    source_user_name: normalizeUsername(sourceUsername),
    target_user_name: String(
      process.env.BATTLECITY_X_USERNAME || BATTLECITIES_USERNAME,
    ).trim(),
  });
  return body?.data?.following === true;
}

async function hasReposted(postId, xUserId) {
  if (!/^\d{1,20}$/.test(String(postId)) || !/^\d{1,20}$/.test(String(xUserId))) {
    throw new Error('Invalid X repost verification target');
  }
  const body = await request('/twitter/tweet/retweeters', { tweetId: String(postId) });
  const users = Array.isArray(body?.users) ? body.users : [];
  return users.some((user) => extractUserId(user) === String(xUserId));
}
async function hasCommented(postId, xUserId) {
  if (!/^\d{1,20}$/.test(String(postId)) || !/^\d{1,20}$/.test(String(xUserId))) throw new Error('Invalid X comment verification target');
  const body = await request('/twitter/tweet/replies', { tweetId: String(postId), queryType: 'Latest' });
  return (Array.isArray(body?.tweets) ? body.tweets : []).some(tweet => extractUserId(tweet?.author || tweet?.user || tweet) === String(xUserId) || String(tweet?.authorId || tweet?.author_id || '') === String(xUserId));
}

async function request(pathname, query) {
  const key = String(process.env.TWITTERAPI_IO_KEY || '').trim();
  if (key === '') throw new Error('TwitterAPI is not configured');
  const url = new URL(pathname, BASE_URL);
  Object.entries(query).forEach(([keyName, value]) => url.searchParams.set(keyName, value));
  const response = await fetch(url, { headers: { 'x-api-key': key } });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.status === 'error') {
    throw createError(response.status, body);
  }
  return body;
}

function normalizeUsername(value) {
  const username = String(value || '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) throw new Error('Invalid linked X username');
  return username;
}

function extractUserId(user) {
  const value = user?.id || user?.userId || user?.user_id || user?.restId;
  return /^\d{1,20}$/.test(String(value || '')) ? String(value) : null;
}

function createError(status, body) {
  const detail = String(body?.detail || body?.message || body?.msg || 'request failed')
    .replace(/[^a-z0-9 -]/gi, '')
    .slice(0, 100);
  return new Error(`TwitterAPI request failed (${status}: ${detail})`);
}

module.exports = { checkFollowRelationship, hasReposted, hasCommented, isConfigured };
