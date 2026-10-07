import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const testDatabaseUrl = process.env.BATTLECITY_TEST_DATABASE_URL;

test('PostgreSQL replay row locks preserve ownership, immutable uploads and one match under concurrent retries', { skip: !testDatabaseUrl }, async (t) => {
  process.env.DATABASE_URL = testDatabaseUrl; process.env.BATTLECITY_STORAGE_MODE = 'postgres'; process.env.NODE_ENV = 'test';
  const database = require('../dist/src/database');
  const store = require('../dist/src/stores/unityReplayStore');
  const matches = require('../dist/src/stores/matchResultStore');
  const seasons = require('../dist/src/stores/seasonStore');
  const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/unity-input-v1.json', import.meta.url), 'utf8'));
  const wallet = require('@solana/web3.js').Keypair.generate().publicKey.toBase58();
  const player = { id: 'ply-pg-replay-' + crypto.randomBytes(8).toString('hex'), provider: 'wallet', walletAddress: wallet, displayName: 'Isolated Replay Test' };
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const originalRandom = crypto.randomBytes;
  t.mock.method(crypto, 'randomBytes', (size) => { if (size !== 4) return originalRandom(size); const bytes = Buffer.alloc(4); bytes.writeUInt32LE(fixture.seed); return bytes; });
  try {
    await database.assertStartupReady();
    await database.getPool().query(`INSERT INTO battlecity_players (id,provider,wallet_address,display_name,created_at,updated_at,last_seen_at)
      VALUES ($1,'wallet',$2,$3,NOW(),NOW(),NOW())`, [player.id, wallet, player.displayName]);
    const settings = Object.fromEntries(['simulationVersion', 'buildVersion', 'levelNumber', 'levelHash', 'configHash', 'tickRate', 'mode'].map((key) => [key, fixture[key]]));
    const session = await store.createSession(player.id, settings); clock += Math.ceil(fixture.durationTicks / 60 * 1000) + 1000;
    const results = await Promise.all(Array.from({ length: 5 }, () => store.submitReplay(player.id, session.id, fixture)));
    assert.equal(results.filter((result) => !result.duplicate).length, 1); const id = results[0].item.id;
    assert.equal(new Set(results.map((result) => result.item.id)).size, 1);
    assert.equal(await store.readReplay(id, 'ply-other-player'), null);
    assert.deepEqual((await store.readReplay(id, player.id)).replay, fixture);
    await assert.rejects(store.submitReplay(player.id, session.id, { ...fixture, debugUsed: true }), { status: 409 });
    const season = await seasons.getCurrentSeason();
    const facts = { replayId: id, levelNumber: fixture.levelNumber, score: fixture.claimedResult.score, won: fixture.claimedResult.won };
    const linked = await Promise.all(Array.from({ length: 5 }, () => store.submitBoundMatch(player, season, facts)));
    assert.equal(new Set(linked.map((match) => match.id)).size, 1); assert.equal(linked[0].validationStatus, 'pending');
    await assert.rejects(matches.submitResult(player, season, facts), { code: '23505' });
    const count = await database.getPool().query('SELECT COUNT(*)::int AS count FROM battlecity_match_results WHERE player_id=$1', [player.id]);
    assert.equal(count.rows[0].count, 1);
    assert.deepEqual(await matches.getPublicPlayerReplay(player.id, linked[0].id), [fixture]);
    assert.equal(await matches.getPublicPlayerReplay('ply-other-player', linked[0].id), null);
    let history = await matches.getPlayerResults(player.id);
    assert.equal(history[0].hasReplay, true); assert.equal(history[0].replayAvailable, true); assert.equal(history[0].replayId, id);
    if (process.env.BATTLECITY_UNITY_REPLAY_VERIFIER) {
      const verifier = require('../dist/src/services/unityReplayVerifier'); const checked = await verifier.verifyStoredReplay(id);
      assert.equal(checked.verification.reproducibilityStatus, 'matched'); assert.equal(checked.validationStatus, 'pending');
      assert.equal(checked.competitiveApproval, 'review_required');
    }
    await database.getPool().query("UPDATE battlecity_replays SET validation_status='rejected' WHERE id=$1", [id]);
    history = await matches.getPlayerResults(player.id);
    assert.equal(history[0].hasReplay, false); assert.equal(history[0].replayAvailable, false); assert.equal(history[0].replayId, null);
    assert.equal(await matches.getPublicPlayerReplay(player.id, linked[0].id), null);
  } finally {
    await database.getPool().query('DELETE FROM battlecity_unity_replay_sessions WHERE player_id=$1', [player.id]);
    await database.getPool().query('DELETE FROM battlecity_match_results WHERE player_id=$1', [player.id]);
    await database.getPool().query('DELETE FROM battlecity_replays WHERE player_id=$1', [player.id]);
    await database.getPool().query('DELETE FROM battlecity_players WHERE id=$1', [player.id]);
    await database.closePool();
  }
});
