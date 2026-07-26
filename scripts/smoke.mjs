const baseUrl = process.env.BATTLECITY_API_SMOKE_URL || 'http://127.0.0.1:3001';
const room = `smoke-${Date.now().toString(36)}`;
const signalPath = `/api/webrtc/matches/${room}/players/0/signals/offer`;

const healthResponse = await fetch(`${baseUrl}/api/health`);
assertStatus(healthResponse, 200, 'health');
const health = await healthResponse.json();
if (health.ok !== true || health.service !== 'battle-cities-api') {
  throw new Error(`Unexpected health response: ${JSON.stringify(health)}`);
}

const readinessResponse = await fetch(`${baseUrl}/api/ready`);
assertStatus(readinessResponse, 200, 'readiness');
const readiness = await readinessResponse.json();
if (readiness.ready !== true || !['local', 'postgres'].includes(readiness.storage)) {
  throw new Error(`Unexpected readiness response: ${JSON.stringify(readiness)}`);
}

const optionsResponse = await fetch(`${baseUrl}/api/session`, {
  method: 'OPTIONS',
  headers: {
    origin: 'https://www.battlecities.com',
    'access-control-request-method': 'POST',
  },
});
assertStatus(optionsResponse, 204, 'CORS preflight');
if (
  optionsResponse.headers.get('access-control-allow-origin') !==
  'https://www.battlecities.com'
) {
  throw new Error('CORS preflight did not return the requested allowed origin');
}

const missingRouteResponse = await fetch(`${baseUrl}/api/not-a-route`, {
  headers: { origin: 'https://www.battlecities.com' },
});
assertStatus(missingRouteResponse, 404, 'missing route');
if (
  missingRouteResponse.headers.get('access-control-allow-origin') !==
  'https://www.battlecities.com'
) {
  throw new Error('Global CORS middleware did not decorate an error response');
}

const publishResponse = await fetch(`${baseUrl}${signalPath}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: 'smoke-offer' }),
});
assertStatus(publishResponse, 201, 'signal publish');
const published = await publishResponse.json();
if (published.ok !== true || !Number.isInteger(published.id)) {
  throw new Error(`Unexpected signal publish response: ${JSON.stringify(published)}`);
}

const readResponse = await fetch(`${baseUrl}${signalPath}?after=0`);
assertStatus(readResponse, 200, 'signal read');
const read = await readResponse.json();
if (read.signal?.code !== 'smoke-offer' || read.signal.id !== published.id) {
  throw new Error(`Unexpected signal read response: ${JSON.stringify(read)}`);
}

const consumedResponse = await fetch(
  `${baseUrl}${signalPath}?after=${published.id}`,
);
assertStatus(consumedResponse, 200, 'signal revision read');
const consumed = await consumedResponse.json();
if (consumed.signal !== null) {
  throw new Error(`Expected no newer signal: ${JSON.stringify(consumed)}`);
}

console.log('BattleCities API smoke test passed');

function assertStatus(response, expected, operation) {
  if (response.status !== expected) {
    throw new Error(
      `${operation} returned ${response.status}; expected ${expected}`,
    );
  }
}
