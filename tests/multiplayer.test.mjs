import assert from 'assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import test from 'node:test';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));

test('multiplayer API routes use deployable shared-code imports', async () => {
  const routeDirectory = path.resolve(testDirectory, '../src/routes/multiplayer');
  const routeFiles = await fs.readdir(routeDirectory);

  for (const routeFile of routeFiles.filter((file) => file.endsWith('.ts'))) {
    const source = await fs.readFile(path.join(routeDirectory, routeFile), 'utf8');
    assert.doesNotMatch(
      source,
      /['"]@battlecities\/shared['"]/,
      `${routeFile} must not use a TypeScript-only path alias at runtime`,
    );
  }

  const signalingSource = await fs.readFile(
    path.resolve(testDirectory, '../src/routes/webrtcSignals.ts'),
    'utf8',
  );
  assert.match(signalingSource, /authorizePlayerJoin/);
  assert.match(signalingSource, /resolveSessionPlayer/);
  assert.match(signalingSource, /broadcasterService\.isAuthorizedRequest/);

  const matchRouteSource = await fs.readFile(
    path.join(routeDirectory, 'matches.ts'),
    'utf8',
  );
  assert.match(matchRouteSource, /Only the broadcaster may submit match results/);
  assert.match(matchRouteSource, /completeAuthoritativeMatch/);
});

test('direct matchmaking charges fuel, fills two slots, and refunds waiting exits', async () => {
  const context = await createContext();
  const [one, two, three] = context.players;

  for (const player of context.players) {
    await context.economy.creditFuel(player, 3, { sourceId: `seed:${player.id}` });
  }

  const first = await context.multiplayer.startDirectMatch(one, 1);
  const second = await context.multiplayer.startDirectMatch(two, 1);
  const third = await context.multiplayer.startDirectMatch(three, 1);

  assert.equal(first.playerSlot, 0);
  assert.equal(second.playerSlot, 1);
  assert.equal(second.match.id, first.match.id);
  assert.equal(second.match.status, 'ready');
  assert.equal(third.playerSlot, 0);
  assert.notEqual(third.match.id, first.match.id);
  assert.equal(
    await context.multiplayer.authorizePlayerJoin(
      one.id,
      first.match.id,
      0,
      first.joinToken,
    ),
    true,
  );
  assert.equal(
    await context.multiplayer.authorizePlayerJoin(
      one.id,
      first.match.id,
      1,
      first.joinToken,
    ),
    false,
  );

  const reconnected = await context.multiplayer.reconnect(one, first.match.id);
  assert.equal(reconnected.reconnected, true);
  assert.equal(reconnected.playerSlot, 0);
  assert.equal((await context.economy.readAccount(one.id)).fuelBalance, 2);

  const exited = await context.multiplayer.exitMatch(three, third.match.id);
  assert.equal(exited.ok, true);
  assert.equal(exited.refundedFuel, 1);
  assert.equal((await context.economy.readAccount(three.id)).fuelBalance, 3);
});

test('fresh direct matchmaking skips stale assignments and pairs active players', async () => {
  const context = await createContext();
  const [one, two] = context.players;
  await context.economy.creditFuel(one, 3, { sourceId: 'fresh-one' });
  await context.economy.creditFuel(two, 3, { sourceId: 'fresh-two' });

  const stale = await context.multiplayer.startDirectMatch(one, 1);
  const statePath = path.join(
    process.env.BATTLECITY_MULTIPLAYER_DIR,
    'state.json',
  );
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.matches.find((match) => match.id === stale.match.id).updatedAt =
    new Date(Date.now() - 60000).toISOString();
  await fs.writeFile(statePath, JSON.stringify(state), 'utf8');

  const active = await context.multiplayer.startDirectMatch(two, 1);
  assert.notEqual(active.match.id, stale.match.id);
  assert.equal(active.match.status, 'waiting');

  const paired = await context.multiplayer.startDirectMatch(one, 1);
  assert.equal(paired.match.id, active.match.id);
  assert.equal(paired.playerSlot, 1);
  assert.equal(paired.match.status, 'ready');
  assert.deepEqual(paired.abandonedMatchIds, [stale.match.id]);
  assert.equal(
    (await context.multiplayer.getMatch(stale.match.id)).status,
    'closed',
  );
});

test('broadcaster startup and shutdown are idempotent and persist lifecycle state', async () => {
  const context = await createContext();
  const [one, two] = context.players;
  await context.economy.creditFuel(one, 1, { sourceId: 'broadcaster-one' });
  await context.economy.creditFuel(two, 1, { sourceId: 'broadcaster-two' });
  const first = await context.multiplayer.startDirectMatch(one, 1);
  await context.multiplayer.startDirectMatch(two, 1);
  await context.economy.purchaseItemForPlayer(one, 'shield', 'token');
  await context.economy.purchaseItemForPlayer(one, 'shield', 'token');
  await context.economy.purchaseItemForPlayer(one, 'speed', 'token');
  await context.economy.purchaseItemForPlayer(two, 'freeze', 'token');
  await context.economy.purchaseItemForPlayer(two, 'extra-life', 'token');
  const playerOneAccount = await context.economy.readAccount(one.id);
  const playerTwoAccount = await context.economy.readAccount(two.id);
  await context.economy.upsertAccountForPlayer(one, {
    inventory: playerOneAccount.inventory,
    loadout: {
      'active-one': 'shield',
      'active-three': 'speed',
    },
  });
  await context.economy.upsertAccountForPlayer(two, {
    inventory: playerTwoAccount.inventory,
    loadout: {
      'active-two': 'freeze',
      'active-four': 'extra-life',
    },
  });

  const previousFetch = globalThis.fetch;
  const previousBaseUrl = process.env.BROADCASTER_BASE_URL;
  const previousToken = process.env.BROADCASTER_SERVICE_TOKEN;
  const calls = [];
  let runtimeExists = false;
  process.env.BROADCASTER_BASE_URL = 'https://broadcaster.example.test';
  process.env.BROADCASTER_SERVICE_TOKEN = 'test-service-token';
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (init?.method === 'DELETE') {
      runtimeExists = false;
      return new Response(null, { status: 204 });
    }
    if (init?.method === undefined) {
      return runtimeExists
        ? new Response(
          JSON.stringify({ status: 'running', workerUrl: 'http://127.0.0.1:9010/' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
        : new Response(JSON.stringify({ error: 'Match not found.' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
    }
    runtimeExists = true;
    return new Response(JSON.stringify({ workerUrl: 'http://127.0.0.1:9010/' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
  };

  try {
    const broadcaster = require('../src/services/broadcasterService');
    assert.equal(
      broadcaster.isAuthorizedRequest(
        new Request('https://api.example.test', {
          headers: { authorization: 'Bearer test-service-token' },
        }),
      ),
      true,
    );
    assert.equal(
      broadcaster.isAuthorizedRequest(new Request('https://api.example.test')),
      false,
    );
    await broadcaster.ensureMatchStarted(first.match.id, 1);
    await broadcaster.ensureMatchStarted(first.match.id, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.headers.authorization, 'Bearer test-service-token');
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      matchId: first.match.id,
      level: 1,
      playerRunConsumables: [
        {
          powerups: ['shield', 'speed'],
          powerupCounts: [2, 1],
        },
        {
          powerups: ['freeze', 'life'],
          powerupCounts: [1, 1],
        },
      ],
    });
    assert.equal(calls[1].init.method, undefined);

    runtimeExists = false;
    await broadcaster.ensureMatchStarted(first.match.id, 1);
    assert.equal(calls.length, 4);
    assert.equal(calls[2].init.method, undefined);
    assert.equal(calls[3].init.method, 'POST');
    assert.equal(
      (await context.multiplayer.getBroadcasterState(first.match.id)).status,
      'running',
    );

    await context.multiplayer.completeAuthoritativeMatch(first.match.id, [
      { playerSlot: 0, score: 500 },
      { playerSlot: 1, score: 500 },
    ]);
    await broadcaster.stopMatch(first.match.id);
    await broadcaster.stopMatch(first.match.id);
    assert.equal(calls.length, 5);
    assert.equal(
      (await context.multiplayer.getBroadcasterState(first.match.id)).status,
      'stopped',
    );
    assert.equal((await context.multiplayer.getMatch(first.match.id)).status, 'completed');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment('BROADCASTER_BASE_URL', previousBaseUrl);
    restoreEnvironment('BROADCASTER_SERVICE_TOKEN', previousToken);
  }
});

test('event entry charges once, never refunds, and leaderboard keeps best tied scores', async () => {
  const context = await createContext();
  const [one, two] = context.players;
  const event = { id: 'evt-test', slug: 'test-event' };

  await context.economy.creditFuel(one, 3, { sourceId: 'event-seed-one' });
  await context.economy.creditFuel(two, 3, { sourceId: 'event-seed-two' });

  const first = await context.multiplayer.startEventMatch(one, event, 1);
  const exited = await context.multiplayer.exitMatch(one, first.match.id);
  assert.equal(exited.ok, true);
  assert.equal(exited.refundedFuel, 0);
  assert.equal((await context.economy.readAccount(one.id)).fuelBalance, 2);

  const restarted = await context.multiplayer.startEventMatch(one, event, 1);
  const joined = await context.multiplayer.startEventMatch(two, event, 1);
  assert.equal(joined.match.id, restarted.match.id);
  assert.equal((await context.economy.readAccount(one.id)).fuelBalance, 2);

  await context.multiplayer.completeAuthoritativeMatch(restarted.match.id, [
    { playerSlot: 0, score: 500 },
    { playerSlot: 1, score: 500 },
  ]);
  const board = await context.multiplayer.getEventLeaderboard(event.id);

  assert.deepEqual(
    board.map((row) => ({ rank: row.rank, score: row.score })),
    [
      { rank: 1, score: 500 },
      { rank: 1, score: 500 },
    ],
  );
});

async function createContext() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'battlecities-multiplayer-'));
  process.env.NODE_ENV = 'development';
  process.env.BATTLECITY_STORAGE_MODE = 'local';
  process.env.BATTLECITY_MULTIPLAYER_DIR = path.join(root, 'multiplayer');
  process.env.BATTLECITY_ECONOMY_DIR = path.join(root, 'economy');
  process.env.BATTLECITY_LEDGER_DIR = path.join(root, 'ledger');

  return {
    economy: require('../src/stores/economyStore'),
    multiplayer: require('../src/stores/multiplayerStore'),
    players: [1, 2, 3].map((index) => ({
      id: `ply-test-${index}`,
      provider: 'google',
      displayName: `Player ${index}`,
      walletAddress: null,
    })),
  };
}

function restoreEnvironment(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
