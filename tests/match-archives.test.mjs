import assert from 'assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import test from 'node:test';

const require = createRequire(import.meta.url);

test('match archives preserve metadata and every authoritative frame', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'battlecities-archives-'));
  const previousMode = process.env.BATTLECITY_STORAGE_MODE;
  const previousDirectory = process.env.BATTLECITY_MATCH_ARCHIVE_DIR;
  process.env.NODE_ENV = 'development';
  process.env.BATTLECITY_STORAGE_MODE = 'local';
  process.env.BATTLECITY_MATCH_ARCHIVE_DIR = root;

  try {
    const store = require('../src/stores/matchArchiveStore');
    const matchId = 'match-archive-test';
    await store.startArchive(matchId, {
      gameType: 'direct',
      category: 'guest',
      level: 1,
      seed: 42,
      simulationConfig: { tickRate: 20, extraLives: 2 },
      players: [
        { playerId: 'ply-one', displayName: 'Player One', slot: 0 },
        { playerId: 'ply-two', displayName: 'Player Two', slot: 1 },
      ],
      startedAt: '2026-07-28T10:00:00.000Z',
    });

    await assert.rejects(
      () => store.appendFrames(matchId, [frame(2)]),
      (error) => error.code === 'ARCHIVE_SEQUENCE_CONFLICT',
    );
    const firstBatch = [frame(1), frame(2)];
    await store.appendFrames(matchId, firstBatch);
    await store.appendFrames(matchId, firstBatch);
    await store.appendFrames(matchId, [frame(3), frame(4)]);
    assert.equal((await store.listArchives()).length, 0);
    assert.equal(
      (await store.listArchives({ includeIncomplete: true })).length,
      1,
    );
    await assert.rejects(
      () => store.appendFrames(matchId, [frame(6)]),
      (error) => error.code === 'ARCHIVE_SEQUENCE_CONFLICT',
    );

    const firstPage = await store.getArchiveFrames(matchId, {
      afterSeq: 0,
      batchLimit: 1,
    });
    assert.deepEqual(firstPage.frames.map((item) => item.seq), [1, 2]);
    assert.equal(firstPage.hasMore, true);

    const secondPage = await store.getArchiveFrames(matchId, {
      afterSeq: firstPage.nextAfterSeq,
      batchLimit: 1,
    });
    assert.deepEqual(secondPage.frames.map((item) => item.seq), [3, 4]);
    assert.equal(secondPage.hasMore, false);

    await store.completeArchive(matchId, {
      result: { matchResult: 'win', scores: [100, 200] },
      completedAt: '2026-07-28T10:05:00.000Z',
    });
    const archive = await store.getArchive(matchId);
    assert.equal(archive.status, 'completed');
    assert.equal(archive.frameCount, 4);
    assert.equal(archive.firstFrameSeq, 1);
    assert.equal(archive.lastFrameSeq, 4);
    assert.equal(archive.finalTick, 4);
    assert.deepEqual(
      archive.players.map((player) => player.displayName),
      ['Player One', 'Player Two'],
    );
    assert.equal((await store.listArchives()).length, 1);
  } finally {
    restoreEnvironment('BATTLECITY_STORAGE_MODE', previousMode);
    restoreEnvironment('BATTLECITY_MATCH_ARCHIVE_DIR', previousDirectory);
    await fs.rm(root, { recursive: true, force: true });
  }
});

function frame(seq) {
  return {
    type: 'webrtc-host-frame',
    seq,
    tick: seq,
    deltaTime: 0.05,
    playerScores: [0, 0],
    sharedElapsedSeconds: seq * 0.05,
    playerOneElapsedSeconds: seq * 0.05,
    playerTwoElapsedSeconds: seq * 0.05,
    players: [],
    powerup: null,
    powerupPickup: null,
    activeEnemyIds: [],
    enemies: [],
  };
}

function restoreEnvironment(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
