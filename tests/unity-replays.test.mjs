import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import test, { beforeEach, afterEach } from 'node:test';
const require = createRequire(import.meta.url);
const api = require('../dist/src/api/router').default;
const store = require('../dist/src/stores/unityReplayStore');
const format = require('../dist/src/services/unityReplayFormat');
const legacy = require('../dist/src/stores/replayStore');
const matches = require('../dist/src/stores/matchResultStore');
const identity = require('../dist/src/services/sessionIdentity');
const sessions = require('../dist/src/stores/sessionStore');
const players = require('../dist/src/stores/playerStore');
const { readNodeBody } = require('../dist/src/services/requestBody');
let root;
let playerCounter = 0;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'battlecities-replay-'));
  process.env.NODE_ENV = 'test'; process.env.BATTLECITY_STORAGE_MODE = 'local';
  process.env.BATTLECITY_UNITY_REPLAY_FILE = path.join(root, 'unity.json');
  process.env.BATTLECITY_REPLAY_DIR = path.join(root, 'legacy');
  process.env.BATTLECITY_MATCH_DIR = path.join(root, 'matches');
  process.env.BATTLECITY_SEASON_DIR = path.join(root, 'seasons');
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const req = (pathname, method = 'GET', body, headers = {}) => new Request('https://api.battlecities.com/api/' + pathname,
  { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const settings = (mode = 'single') => ({ simulationVersion: 'unity-sim-v1', buildVersion: '0.1.10', levelNumber: 1,
  levelHash: 'a'.repeat(64), configHash: 'b'.repeat(64), tickRate: 60, mode });
function recording(session) {
  return { format: format.FORMAT, ...settings(session.mode), seed: session.seed,
    id: '0123456789abcdef0123456789abcdef', createdAt: new Date().toISOString(), durationTicks: 120,
    map: { field: { widthTiles: 13, heightTiles: 13 }, terrain: { regions: [] }, objects: [], spawn: null, base: null },
    config: { normalReload: 0.12, upgradedReload: 0.08, playerTier: 0, turretRange: 640, turretDamage: 4,
      turretCooldown: 0.1, turretReload: 0.5, turretTurn: 0.2, turretMuzzle: 32, turretHealth: 10, turretDeploy: 0.5, landDrone: {} },
    inputs: [{ tick: 1, count: 120, commands: [0, 0, 0, 0], secondaries: [0, 0, 0, 0], enemyFire: true }],
    events: [], checkpoints: [0, 60, 120].map((tick) => ({ tick, stateHash: 'c'.repeat(64) })),
    claimedResult: { score: 1000, lives: 0, remaining: 10, won: false, lost: true, winnerSlot: -1 },
    completion: 'completed', debugUsed: false };
}
function auth(t) {
  let player = { id: `ply-replay-${++playerCounter}`, provider: 'wallet', walletAddress: 'test-wallet', displayName: 'Replay Test' };
  const knownPlayers = new Map([[player.id, player]]);
  t.mock.method(identity, 'resolveSession', () => 'sess-test');
  t.mock.method(sessions, 'readSession', async () => ({ playerId: player.id, provider: player.provider, walletAddress: player.walletAddress }));
  t.mock.method(players, 'readPlayer', async (id) => knownPlayers.get(id) || null);
  return { current: () => player, change: (walletAddress = 'test-wallet') => { player = { ...player, id: `ply-replay-${++playerCounter}`, walletAddress }; knownPlayers.set(player.id, player); } };
}
async function start(mode = 'single') {
  const response = await api.fetch(req('replay-sessions', 'POST', settings(mode)));
  assert.equal(response.status, 201); return (await response.json()).session;
}
async function upload(session, replay = recording(session)) {
  const response = await api.fetch(req('replays/unity', 'POST', { sessionId: session.id, replay }));
  assert.equal(response.status, 201); return (await response.json()).item;
}

test('replay session, ingestion, status, retrieval and admin evidence require authentication', async () => {
  for (const [route, method] of [['replay-sessions', 'POST'], ['replay-sessions?id=urs-' + '0'.repeat(32), 'GET'],
    ['replays/unity', 'POST'], ['replays/unity?id=urp-' + '0'.repeat(32), 'GET'],
    ['replays/unity/status?id=urp-' + '0'.repeat(32), 'GET'], ['admin/replays/unity?id=urp-' + '0'.repeat(32), 'GET']]) {
    assert.equal((await api.fetch(req(route, method, method === 'POST' ? {} : undefined))).status, 401);
  }
});
test('server session binds seed/content/config/version/mode and derives ownership', async (t) => {
  auth(t); const session = await start();
  assert.match(session.id, /^urs-[a-f0-9]{32}$/); assert.ok(session.seed > 0 && session.seed <= 0xffffffff);
  assert.equal(session.configHash, settings().configHash);
  assert.equal(Date.parse(session.expiresAt) - Date.parse(session.issuedAt), 86400000);
  for (const [key, value] of [['seed', session.seed === 1 ? 2 : 1], ['levelHash', 'd'.repeat(64)], ['configHash', 'd'.repeat(64)], ['buildVersion', 'evil'], ['mode', 'coop']]) {
    const response = await api.fetch(req('replays/unity', 'POST', { sessionId: session.id, replay: { ...recording(session), [key]: value } }));
    assert.equal(response.status, 409, key);
  }
  assert.equal((await api.fetch(req('replay-sessions', 'POST', { ...settings(), playerId: 'ply-other' }))).status, 400);
});
test('owned upload/retrieval and status stay pending; payload has no caller approval fields', async (t) => {
  const principal = auth(t); const session = await start(); const replay = recording(session); const item = await upload(session, replay);
  assert.equal(item.validationStatus, 'pending'); assert.equal(item.verificationStatus, 'pending');
  assert.equal(item.competitiveApproval, 'review_required'); assert.equal(item.rewardCandidate, true);
  const download = await (await api.fetch(req('replays/unity?id=' + item.id))).json();
  assert.deepEqual(download.item.replay, replay);
  const status = await (await api.fetch(req('replays/unity/status?id=' + item.id))).json();
  assert.equal(status.item.replay, undefined); assert.equal(status.item.playerId, undefined);
  assert.equal((await api.fetch(req('replays/unity/status?id=' + item.id, 'POST', { status: 'verified' }))).status, 405);
  principal.change();
  for (const route of ['replay-sessions?id=' + session.id, 'replays/unity?id=' + item.id, 'replays/unity/status?id=' + item.id]) {
    assert.equal((await api.fetch(req(route))).status, 404);
  }
  assert.equal((await api.fetch(req('replays/unity', 'POST', { sessionId: session.id, replay }))).status, 404);
});
test('identical concurrent retries create one replay; changed evidence cannot replace it', async () => {
  const playerId = 'ply-retry'; const session = await store.createSession(playerId, settings()); const replay = recording(session);
  const results = await Promise.all(Array.from({ length: 8 }, () => store.submitReplay(playerId, session.id, replay)));
  assert.equal(results.filter((result) => !result.duplicate).length, 1);
  assert.equal(new Set(results.map((result) => result.item.id)).size, 1);
  const reordered = Object.fromEntries(Object.entries(replay).reverse());
  assert.equal((await store.submitReplay(playerId, session.id, reordered)).duplicate, true);
  await assert.rejects(store.submitReplay(playerId, session.id, { ...replay, debugUsed: true }), { status: 409 });
});
test('expired sessions reject first upload but allow retrieval and identical retry after acceptance', async () => {
  const playerId = 'ply-expiry'; let session = await store.createSession(playerId, settings()); let replay = recording(session);
  const expire = async (id) => {
    const state = JSON.parse(await fs.readFile(process.env.BATTLECITY_UNITY_REPLAY_FILE, 'utf8'));
    state.sessions[id].expiresAt = new Date(Date.now() - 1000).toISOString(); await fs.writeFile(process.env.BATTLECITY_UNITY_REPLAY_FILE, JSON.stringify(state));
  };
  await expire(session.id); await assert.rejects(store.submitReplay(playerId, session.id, replay), { status: 410 });
  session = await store.createSession(playerId, settings()); replay = recording(session);
  const first = await store.submitReplay(playerId, session.id, replay); await expire(session.id);
  assert.equal((await store.submitReplay(playerId, session.id, replay)).duplicate, true);
  assert.ok(await store.readReplay(first.item.id, playerId));
});
test('RLE coverage, numeric bounds, input bits, slot/mode, events and checkpoints are enforced', () => {
  const session = { ...settings(), seed: 5 }; const good = recording(session); assert.equal(format.validateReplay(good), good);
  const changes = [
    (r) => { r.inputs[0].tick = 0; }, (r) => { r.inputs[0].count = 119; },
    (r) => { r.inputs[0].commands[0] = 512; }, (r) => { r.inputs[0].commands[0] = 7; },
    (r) => { r.inputs[0].commands[0] = 56; }, (r) => { r.inputs[0].commands[1] = 64; },
    (r) => { r.inputs[0].secondaries[0] = 5; }, (r) => { r.durationTicks = 108001; },
    (r) => { r.config.normalReload = NaN; }, (r) => { r.claimedResult.score = -1; },
    (r) => { r.claimedResult.won = true; }, (r) => { r.map.field.widthTiles = 1000; },
    (r) => { r.map.terrain.regions = [{ type: 'brick', x: 0, y: 0, width: 4096, height: 4096 }, { type: 'steel', x: 0, y: 0, width: 4096, height: 4096 }]; },
    (r) => { r.checkpoints.splice(1, 1); }, (r) => { r.checkpoints[2].stateHash = 'fake'; },
    (r) => { r.events = [{ tick: 1, kind: 'powerup', value: 'infinite-lives', slot: 0, connected: false }]; },
    (r) => { r.events = [{ tick: 121, kind: 'pickup', value: null, slot: 0, connected: false }]; },
    (r) => { r.verificationStatus = 'verified'; }
  ];
  for (const change of changes) { const replay = structuredClone(good); change(replay); assert.throws(() => format.validateReplay(replay), format.ReplayError); }
  const legal = structuredClone(good); legal.inputs[0].commands[0] = 511 & ~7 & ~(7 << 3) | 4 | 4 << 3;
  legal.events = [{ tick: 1, kind: 'pickup', value: null, slot: 0, connected: false }]; assert.doesNotThrow(() => format.validateReplay(legal));
});
test('byte limits cover declared and streamed bodies before JSON parsing', async () => {
  await assert.rejects(format.readBoundedJson(new Request('https://api.test', { method: 'POST', body: '{}', headers: { 'content-length': String(format.LIMITS.maxBytes + 1) } })), { status: 413 });
  await assert.rejects(format.readBoundedJson(new Request('https://api.test', { method: 'POST', body: 'x'.repeat(21) }), 20), { status: 413 });
  const stream = Readable.from([Buffer.alloc(6), Buffer.alloc(6)]); stream.headers = {};
  await assert.rejects(readNodeBody(stream, 10), { status: 413 });
  const small = Readable.from([Buffer.from('a'), Buffer.from('b')]); small.headers = {};
  assert.equal((await readNodeBody(small, 10)).toString(), 'ab');
});
test('replay-backed match submissions are owned, claim-bound and idempotent', async (t) => {
  const principal = auth(t); const session = await start(); const item = await upload(session);
  const facts = { replayId: item.id, mode: 'single', levelNumber: 1, score: 1000, won: false };
  assert.equal((await api.fetch(req('matches/submit', 'POST', { ...facts, score: 9000 }))).status, 409);
  const first = await (await api.fetch(req('matches/submit', 'POST', facts))).json();
  assert.equal(first.result.validationStatus, 'pending'); assert.equal(first.result.replayId, item.id);
  const repeated = await Promise.all(Array.from({ length: 4 }, () => api.fetch(req('matches/submit', 'POST', facts))));
  for (const response of repeated) assert.equal((await response.json()).result.id, first.result.id);
  assert.equal(await matches.getPlayerResultCount(principal.current().id), 1);
  assert.equal((await matches.getPublicPlayerReplay(principal.current().id, first.result.id)).length, 1);
  principal.change(); assert.equal((await api.fetch(req('matches/submit', 'POST', facts))).status, 404);
});
test('multiplayer/debug/incomplete recordings store evidence without entering the single match board', async () => {
  for (const [mode, changes] of [['coop', {}], ['versus', {}], ['single', { debugUsed: true }], ['single', { inputs: [{ tick: 1, count: 120, commands: [0, 0, 0, 0], secondaries: [0, 0, 0, 0], enemyFire: false }] }], ['single', { completion: 'truncated' }], ['single', { completion: 'aborted' }]]) {
    const player = { id: 'ply-ineligible-' + mode + '-' + Object.keys(changes).join(''), provider: 'wallet' };
    const session = await store.createSession(player.id, settings(mode)); const replay = { ...recording(session), ...changes };
    const result = await store.submitReplay(player.id, session.id, replay); assert.equal(result.item.rewardCandidate, false);
    await assert.rejects(store.submitBoundMatch(player, { id: 'season-test' }, { replayId: result.item.id, levelNumber: 1, score: 1000, won: false }), { status: 400 });
  }
});
test('trusted reproduction is payload-bound and separate from fair-play approval', async () => {
  const playerId = 'ply-verifier'; const session = await store.createSession(playerId, settings()); const replay = recording(session);
  const { item } = await store.submitReplay(playerId, session.id, replay);
  const evidence = { payloadHash: item.payloadHash, simulationVersion: replay.simulationVersion, status: 'matched', result: replay.claimedResult };
  await assert.rejects(store.recordReproduction(item.id, { ...evidence, payloadHash: 'f'.repeat(64) }), { status: 409 });
  await assert.rejects(store.recordReproduction(item.id, { ...evidence, result: { ...replay.claimedResult, score: 9999 } }), { status: 409 });
  const outcome = await store.recordReproduction(item.id, evidence);
  assert.equal(outcome.verification.reproducibilityStatus, 'matched'); assert.equal(outcome.validationStatus, 'pending');
  assert.equal(outcome.verificationStatus, 'pending'); assert.equal(outcome.competitiveApproval, 'review_required');
  await assert.rejects(store.recordReproduction(item.id, { ...evidence, status: 'diverged' }), { status: 409 });
});
test('divergence rejects evidence and its pending match without granting any rewards', async () => {
  const player = { id: 'ply-diverged', provider: 'wallet' }; const session = await store.createSession(player.id, settings());
  const replay = recording(session); const { item } = await store.submitReplay(player.id, session.id, replay);
  const match = await store.submitBoundMatch(player, { id: 'season-test' }, { replayId: item.id, levelNumber: 1, score: 1000, won: false });
  const rejected = await store.recordReproduction(item.id, { payloadHash: item.payloadHash, simulationVersion: 'unity-sim-v1', status: 'diverged', reason: 'Checkpoint mismatch' });
  assert.equal(rejected.validationStatus, 'rejected'); assert.equal((await matches.readResult(match.id, player.id)).validationStatus, 'rejected');
  assert.equal(await matches.getPlayerResultCount(player.id), 0);
  await assert.rejects(store.submitBoundMatch(player, { id: 'season-test' }, { replayId: item.id, levelNumber: 1, score: 1000, won: false }), { status: 400 });
});
test('legacy metadata-only verification never certifies a score', async () => {
  const replay = { seed: 1, levelNumber: 1, deviceFrames: {}, activeDeviceType: 0, enemyTraces: {}, powerupSpawns: [],
    metadata: { matchStatus: 'pending', score: 1000, kills: 0, gameResult: 'loss', durationTicks: 10 } };
  const created = await legacy.createRecord('guest-legacy', replay, 'ply-legacy');
  assert.equal(created.validationStatus, 'pending');
  assert.equal((await legacy.verifyRecord(created.id, created.guestId)).validationStatus, 'pending');
});

test('recent list contains only owned summaries and validates list bounds', async (t) => {
  const principal = auth(t); const session = await start(); const item = await upload(session);
  const listed = await (await api.fetch(req('replays/unity?limit=1'))).json();
  assert.equal(listed.items.length, 1); assert.equal(listed.items[0].id, item.id); assert.equal(listed.items[0].replay, undefined);
  assert.equal((await api.fetch(req('replays/unity?limit=51'))).status, 400);
  assert.equal((await api.fetch(req('replays/unity/status'))).status, 400);
  principal.change(); assert.deepEqual((await (await api.fetch(req('replays/unity'))).json()).items, []);
});
test('profile WATCH is public for attached matches and exposes only playback data', async (t) => {
  const principal = auth(t); const ownerId = principal.current().id; const session = await start(); const replay = recording(session); const item = await upload(session, replay);
  const match = await store.submitBoundMatch(principal.current(), { id: 'season-test' }, { replayId: item.id, levelNumber: 1, score: 1000, won: false });
  const route = `players/${ownerId}/profile/matches/${match.id}/replay`;
  const owned = await (await api.fetch(req(route))).json(); assert.equal(owned.item.replay.format, format.FORMAT); assert.equal(owned.item.replays.length, 1);
  assert.deepEqual(Object.keys(owned).sort(), ['item']); assert.deepEqual(Object.keys(owned.item).sort(), ['replay', 'replays']);
  assert.deepEqual(owned.item.replay, replay);
  principal.change(); assert.equal((await api.fetch(req(route))).status, 200);
  assert.equal((await api.fetch(req('replays/unity?id=' + item.id))).status, 404);
  assert.equal((await api.fetch(req('replays/unity/status?id=' + item.id))).status, 404);
  assert.equal((await api.fetch(req('replay-sessions?id=' + session.id))).status, 404);
  assert.equal((await api.fetch(req('admin/replays/unity?id=' + item.id))).status, 403);
  principal.change('9YpW9nYJaUVhRwqWaJBBh9wkjCYh5RLr6krYvfr7GGKo');
  const admin = await api.fetch(req(route)); assert.equal(admin.status, 200);
  assert.equal((await admin.json()).item.replay.format, format.FORMAT);
  assert.equal((await api.fetch(req('admin/replays/unity?id=' + item.id))).status, 200);
  t.mock.method(identity, 'resolveSession', () => null);
  const anonymous = await api.fetch(req(route)); assert.equal(anonymous.status, 200);
  assert.deepEqual(await anonymous.json(), owned);
  assert.equal((await api.fetch(req('replays/unity?id=' + item.id))).status, 401);
  assert.equal((await api.fetch(req('replays/unity/status?id=' + item.id))).status, 401);
  assert.equal((await api.fetch(req('replay-sessions?id=' + session.id))).status, 401);
  assert.equal((await api.fetch(req('admin/replays/unity?id=' + item.id))).status, 401);
});

test('public match history flags exclude missing, rejected, wrong-owner and unattached recordings', async (t) => {
  const principal = auth(t); const owner = principal.current();
  const session = await start(); const item = await upload(session);
  const route = `players/${owner.id}/profile`;
  const season = { id: 'season-test' };
  const facts = { replayId: item.id, levelNumber: 1, score: 1000, won: false };
  assert.deepEqual((await (await api.fetch(req(route))).json()).item.recentMatches, []);
  assert.equal((await api.fetch(req(`${route}/matches/${item.id}/replay`))).status, 404);
  const attached = await store.submitBoundMatch(owner, season, facts);
  const missing = await matches.submitResult(owner, season, { ...facts, replayId: 'urp-' + '0'.repeat(32) });
  const noReplay = await matches.submitResult(owner, season, { levelNumber: 1, score: 0 });
  principal.change(); const otherSession = await start(); const otherItem = await upload(otherSession);
  const wrongOwner = await matches.submitResult(owner, season, { ...facts, replayId: otherItem.id });
  t.mock.method(identity, 'resolveSession', () => null);
  let history = (await (await api.fetch(req(route))).json()).item.recentMatches;
  assert.equal(history.find((row) => row.id === attached.id).hasReplay, true);
  assert.equal(history.find((row) => row.id === attached.id).replayAvailable, true);
  for (const match of [missing, noReplay, wrongOwner]) {
    const row = history.find((row) => row.id === match.id);
    assert.equal(row.hasReplay, false); assert.equal(row.replayAvailable, false); assert.equal(row.replayId, null);
    assert.equal((await api.fetch(req(`${route}/matches/${match.id}/replay`))).status, 404);
  }
  assert.equal((await api.fetch(req(`${route}/matches/${attached.id}/replay`))).status, 200);
  const state = JSON.parse(await fs.readFile(process.env.BATTLECITY_UNITY_REPLAY_FILE, 'utf8'));
  state.sessions[session.id].record.validationStatus = 'rejected';
  await fs.writeFile(process.env.BATTLECITY_UNITY_REPLAY_FILE, JSON.stringify(state));
  history = (await (await api.fetch(req(route))).json()).item.recentMatches;
  const rejected = history.find((row) => row.id === attached.id);
  assert.equal(rejected.hasReplay, false); assert.equal(rejected.replayAvailable, false); assert.equal(rejected.replayId, null);
  assert.equal((await api.fetch(req(`${route}/matches/${attached.id}/replay`))).status, 404);
});
test('currency pickups and selected secondary slots match the concrete Unity recorder', () => {
  const replay = recording({ mode: 'single', seed: 5 }); replay.inputs[0].secondaries = [4, 4, 4, 4];
  replay.events = ['batc100', 'batc200'].map((value, index) => ({ tick: index + 1, kind: 'pickup', value, slot: 0, connected: false }));
  assert.doesNotThrow(() => format.validateReplay(replay));
  replay.events[0].kind = 'powerup'; assert.throws(() => format.validateReplay(replay), format.ReplayError);
});

test('real C# fixture ingests, links to history and round-trips through the trusted shared verifier', async (t) => {
  const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/unity-input-v1.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => format.validateReplay(fixture));
  const principal = auth(t); let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const originalRandom = crypto.randomBytes;
  t.mock.method(crypto, 'randomBytes', (size) => { if (size !== 4) return originalRandom(size); const bytes = Buffer.alloc(4); bytes.writeUInt32LE(fixture.seed); return bytes; });
  const input = Object.fromEntries(['simulationVersion', 'buildVersion', 'levelNumber', 'levelHash', 'configHash', 'tickRate', 'mode'].map((key) => [key, fixture[key]]));
  const sessionResponse = await api.fetch(req('replay-sessions', 'POST', input)); const session = (await sessionResponse.json()).session;
  clock += Math.ceil(fixture.durationTicks / 60 * 1000) + 1000;
  const item = await upload(session, fixture);
  const match = await store.submitBoundMatch(principal.current(), { id: 'season-test' }, { replayId: item.id, levelNumber: fixture.levelNumber, score: fixture.claimedResult.score, won: fixture.claimedResult.won });
  assert.equal(match.validationStatus, 'pending');
  if (process.env.BATTLECITY_UNITY_REPLAY_VERIFIER) {
    const checked = await require('../dist/src/services/unityReplayVerifier').verifyStoredReplay(item.id);
    assert.equal(checked.verification.reproducibilityStatus, 'matched'); assert.equal(checked.verificationStatus, 'pending');
  }
});
