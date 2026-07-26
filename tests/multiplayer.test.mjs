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

  const reconnected = await context.multiplayer.reconnect(one, first.match.id);
  assert.equal(reconnected.reconnected, true);
  assert.equal(reconnected.playerSlot, 0);
  assert.equal((await context.economy.readAccount(one.id)).fuelBalance, 2);

  const exited = await context.multiplayer.exitMatch(three, third.match.id);
  assert.equal(exited.ok, true);
  assert.equal(exited.refundedFuel, 1);
  assert.equal((await context.economy.readAccount(three.id)).fuelBalance, 3);
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

  await context.multiplayer.submitScore(one, restarted.match.id, 500);
  await context.multiplayer.submitScore(one, restarted.match.id, 450);
  await context.multiplayer.submitScore(two, restarted.match.id, 500);
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
