const baseUrl = process.env.BATTLECITY_API_SMOKE_URL || 'http://127.0.0.1:3001';
for (const path of ['health', 'ready', 'session', 'seasons/current', 'economy/catalog', 'rankings', 'leaderboard/rewards', 'leaderboard/cycles', 'leaderboard/payouts']) {
  const response = await fetch(`${baseUrl}/api/${path}`, { signal: AbortSignal.timeout(10000) });
  if (response.status !== 200) throw new Error(`${path} returned ${response.status}`);
  await response.json();
}
const preflight = await fetch(`${baseUrl}/api/session`, { method: 'OPTIONS', headers: {
  origin: 'https://www.battlecities.com', 'access-control-request-method': 'POST' } });
if (preflight.status !== 204 || preflight.headers.get('access-control-allow-origin') !== 'https://www.battlecities.com') throw new Error('CORS preflight failed');
for (const path of ['auth/google/start', 'multiplayer/matches/live', 'webrtc/matches/test/observers', 'admin/tournaments', 'staking/summary', 'presale/state', 'events', 'phases', 'quests', 'airdrops/eligibility', 'boost/status', 'cherry-embed-token']) {
  const response = await fetch(`${baseUrl}/api/${path}`);
  if (response.status !== 404) throw new Error(`Retired route ${path} returned ${response.status}`);
}
console.log('BattleCities retained API smoke test passed');
