const crypto = require('crypto');
const store = require('../stores/nativeOAuthStore');
const sessions = require('../stores/sessionStore');
const x = require('./xOAuth');
const discord = require('./discordOAuth');
const connections = require('../stores/xConnectionStore');
const discordVerification = require('../stores/discordVerificationStore');

function returnUrl(value) {
  if (!value) return null;
  const allowed = String(process.env.BATTLECITY_NATIVE_OAUTH_RETURN_URLS || '').split(',').map((v) => v.trim()).filter(Boolean);
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error('Native return URL is not allowed.');
  const url = new URL(value);
  if (url.username || url.password || ['javascript:', 'data:', 'file:'].includes(url.protocol)) throw new Error('Invalid return URL.');
  return value;
}
async function start(provider, player, sessionId, origin, redirect) {
  const service = provider === 'x' ? x : provider === 'discord' ? discord : null;
  if (!service || !service.isConfigured()) throw new Error('Social OAuth is not configured.');
  const payload = { sessionId, origin, returnUrl: returnUrl(redirect), codeVerifier: crypto.randomBytes(32).toString('base64url') };
  const flow = await store.create(provider, player.id, payload);
  const authorizationUrl = service.createAuthorizationUrl(origin, player.id, sessionId,
    { state: `native.${flow.token}`, codeVerifier: payload.codeVerifier });
  return { flowId: flow.token, expiresAt: flow.expiresAt, authorizationUrl };
}
async function callback(provider, request) {
  const url = new URL(request.url), state = url.searchParams.get('state') || '';
  if (!state.startsWith('native.')) return null;
  const token = state.slice(7);
  let flow;
  try { flow = await store.consume(token, provider); } catch { return response('Invalid or expired connection.', 400); }
  if (!flow) return response('Invalid, expired, or already used connection.', 400);
  let status = 'failed';
  try {
    const session = await sessions.readSession(flow.payload.sessionId);
    if (!session || session.playerId !== flow.playerId) throw new Error('Original session expired.');
    if (url.searchParams.has('error')) throw new Error('Authorization cancelled.');
    const code = url.searchParams.get('code');
    const profile = provider === 'x' ? await x.completeNative(code, flow.payload.codeVerifier)
      : await discord.completeNative(code, flow.payload.origin);
    // Recheck logout during the provider exchange before linking the account.
    const current = await sessions.readSession(flow.payload.sessionId);
    if (!current || current.playerId !== flow.playerId) throw new Error('Original session expired.');
    const result = provider === 'x' ? await connections.linkAccount(flow.playerId, profile.id, profile.username)
      : await discordVerification.verifyDiscordAccount(flow.playerId, profile.id, profile.global_name || profile.username);
    if (!result.ok) throw new Error('Account could not be linked.');
    status = 'completed';
  } catch { /* Polling reports the outcome without leaking provider tokens. */ }
  await store.finish(token, status);
  if (flow.payload.returnUrl) {
    const target = new URL(flow.payload.returnUrl);
    target.searchParams.set('provider', provider); target.searchParams.set('status', status);
    return new Response(null, { status: 302, headers: { location: target.toString(), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
  }
  return response(status === 'completed' ? 'Account connected. You can return to Battle Cities.' : 'Connection failed. Return to Battle Cities and try again.');
}
function response(text, status = 200) { return new Response(text, { status, headers: {
  'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } }); }
module.exports = { start, callback, returnUrl };
