const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const database = require('../database');
const storage = require('../config/storageConfig');
const format = require('../services/unityReplayFormat');
const { ReplayError } = format;
const TABLE = 'battlecity_unity_replay_sessions';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
let localQueue = Promise.resolve();
const statePath = () => process.env.BATTLECITY_UNITY_REPLAY_FILE || path.join(process.cwd(), 'server-data', 'unity-replays.json');
const isSessionId = (id) => typeof id === 'string' && /^urs-[a-f0-9]{32}$/.test(id);
const isReplayId = (id) => typeof id === 'string' && /^urp-[a-f0-9]{32}$/.test(id);
const assertPlayer = (id) => { if (typeof id !== 'string' || !/^ply-[a-z0-9-]{1,100}$/i.test(id)) throw new ReplayError(401, 'Not logged in'); };
async function readState() {
  try { return JSON.parse(await fs.readFile(statePath(), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { sessions: {} }; throw error; }
}
async function writeState(state) {
  const file = statePath(); await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 }); await fs.rename(temporary, file);
}
function localMutation(operation) {
  const run = async () => { const state = await readState(); const result = await operation(state); await writeState(state); return result; };
  const next = localQueue.then(run, run); localQueue = next.catch(() => {}); return next;
}
function fromRow(row) {
  if (!row) return null;
  return { id: row.id, playerId: row.player_id, seed: Number(row.seed), ...row.settings_json,
    issuedAt: new Date(row.issued_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(),
    replayId: row.replay_id, record: row.record_json || null, matchResultId: row.match_result_id || null };
}
function toSession(session) {
  if (!session) return null;
  return { id: session.id, playerId: session.playerId, seed: session.seed, simulationVersion: session.simulationVersion, buildVersion: session.buildVersion,
    levelNumber: session.levelNumber, levelHash: session.levelHash, configHash: session.configHash, tickRate: session.tickRate,
    mode: session.mode, issuedAt: session.issuedAt, expiresAt: session.expiresAt, replayId: session.replayId,
    status: session.replayId ? 'submitted' : Date.parse(session.expiresAt) <= Date.now() ? 'expired' : 'active',
    verificationStatus: session.record?.verificationStatus || 'pending' };
}
function toSummary(record) {
  if (!record) return null;
  const { replay, playerId, ...summary } = record;
  return summary;
}
async function createSession(playerId, input) {
  assertPlayer(playerId); const settings = format.validateSessionInput(input);
  let seed = 0; while (seed === 0) seed = crypto.randomBytes(4).readUInt32LE();
  const issuedAt = Date.now();
  const session = { id: `urs-${crypto.randomBytes(16).toString('hex')}`, playerId, seed, ...settings,
    issuedAt: new Date(issuedAt).toISOString(), expiresAt: new Date(issuedAt + SESSION_TTL_MS).toISOString(), replayId: null, record: null, matchResultId: null };
  if (storage.hasDatabaseConfig()) {
    await database.assertMigrationsApplied();
    await database.getPool().query(`INSERT INTO ${TABLE} (id, player_id, seed, settings_json, issued_at, expires_at)
      VALUES ($1,$2,$3,$4::jsonb,$5,$6)`, [session.id, playerId, seed, JSON.stringify(settings), session.issuedAt, session.expiresAt]);
  } else await localMutation(async (state) => { state.sessions[session.id] = session; });
  return toSession(session);
}
async function readSession(id, playerId) {
  assertPlayer(playerId); if (!isSessionId(id)) return null;
  if (storage.hasDatabaseConfig()) {
    await database.assertMigrationsApplied();
    return toSession(fromRow((await database.getPool().query(`SELECT * FROM ${TABLE} WHERE id=$1 AND player_id=$2`, [id, playerId])).rows[0]));
  }
  const session = (await readState()).sessions[id]; return session?.playerId === playerId ? toSession(session) : null;
}
async function mutateSession(id, playerId, operation) {
  assertPlayer(playerId); if (!isSessionId(id)) throw new ReplayError(400, 'Invalid replay session ID');
  if (storage.hasDatabaseConfig()) {
    await database.assertMigrationsApplied();
    return database.withTransaction(async () => {
      const db = database.getPool();
      const session = fromRow((await db.query(`SELECT * FROM ${TABLE} WHERE id=$1 AND player_id=$2 FOR UPDATE`, [id, playerId])).rows[0]);
      if (!session) throw new ReplayError(404, 'Replay session not found');
      const result = await operation(session, db);
      const record = session.record ? { ...session.record } : null; if (record) delete record.replay;
      await db.query(`UPDATE ${TABLE} SET replay_id=$2, record_json=$3::jsonb, match_result_id=$4 WHERE id=$1`,
        [id, session.replayId, record ? JSON.stringify(record) : null, session.matchResultId]);
      return result;
    });
  }
  return localMutation(async (state) => {
    const session = state.sessions[id]; if (session?.playerId !== playerId) throw new ReplayError(404, 'Replay session not found');
    return operation(session, null);
  });
}
function checkBinding(session, replay) {
  for (const key of ['seed', 'simulationVersion', 'buildVersion', 'levelNumber', 'levelHash', 'configHash', 'tickRate', 'mode']) {
    if (session[key] !== replay[key]) throw new ReplayError(409, `Replay does not match issued ${key}`);
  }
}
async function submitReplay(playerId, sessionId, replay) {
  format.validateReplay(replay); const hash = format.payloadHash(replay);
  return mutateSession(sessionId, playerId, async (session, db) => {
    checkBinding(session, replay);
    if (session.replayId) {
      if (session.record.payloadHash !== hash) throw new ReplayError(409, 'Replay session already has different evidence');
      return { item: toSummary(session.record), session: toSession(session), duplicate: true };
    }
    if (Date.parse(session.expiresAt) <= Date.now()) throw new ReplayError(410, 'Replay session expired');
    if (replay.durationTicks > Math.floor((Date.now() - Date.parse(session.issuedAt)) * 60 / 1000) + 900) throw new ReplayError(409, 'Replay duration exceeds issued session time');
    const debugUsed = replay.debugUsed || replay.inputs.some((frame) => !frame.enemyFire);
    const record = { id: `urp-${crypto.randomBytes(16).toString('hex')}`, playerId, sessionId, payloadHash: hash,
      createdAt: new Date().toISOString(), levelNumber: replay.levelNumber, mode: replay.mode, durationTicks: replay.durationTicks,
      validationStatus: 'pending', verificationStatus: 'pending', claimedResult: replay.claimedResult,
      completion: replay.completion, debugUsed,
      rewardCandidate: replay.mode === 'single' && replay.completion === 'completed' && !debugUsed && (replay.claimedResult.won || replay.claimedResult.lost),
      competitiveApproval: 'review_required',
      verification: { method: 'none', reproducibilityStatus: 'pending', checkedAt: null, reason: null }, replay };
    if (db) await db.query(`INSERT INTO battlecity_replays
      (id, guest_id, player_id, created_at, level_number, score, kills, game_result, duration_ticks, validation_status, replay_json)
      VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,'pending',$9::jsonb)`, [record.id, `unity:${playerId}`, playerId,
        record.createdAt, replay.levelNumber, replay.claimedResult.score, replay.claimedResult.won ? 'win' : 'loss', replay.durationTicks, JSON.stringify(replay)]);
    session.replayId = record.id; session.record = record;
    return { item: toSummary(record), session: toSession(session), duplicate: false };
  });
}
async function findReplay(id, playerId, admin = false) {
  if (!isReplayId(id)) return null; if (!admin) assertPlayer(playerId);
  if (storage.hasDatabaseConfig()) {
    await database.assertMigrationsApplied();
    const result = await database.getPool().query(`SELECT s.*, r.replay_json FROM ${TABLE} s
      JOIN battlecity_replays r ON r.id=s.replay_id AND r.player_id=s.player_id
      WHERE s.replay_id=$1 AND ($2::text IS NULL OR s.player_id=$2)`, [id, admin ? null : playerId]);
    const row = result.rows[0]; if (!row) return null;
    return { ...row.record_json, replay: row.replay_json };
  }
  const session = Object.values((await readState()).sessions).find((entry) => entry.replayId === id && (admin || entry.playerId === playerId));
  return session?.record || null;
}
const readReplay = (id, playerId) => findReplay(id, playerId);
const readReplayAdmin = (id) => findReplay(id, null, true);
async function listSummaries(playerId, limit = 20) {
  assertPlayer(playerId);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ReplayError(400, 'Replay list limit must be 1 to 50');
  if (storage.hasDatabaseConfig()) {
    await database.assertMigrationsApplied();
    const rows = (await database.getPool().query(`SELECT record_json FROM ${TABLE}
      WHERE player_id=$1 AND replay_id IS NOT NULL ORDER BY issued_at DESC, id DESC LIMIT $2`, [playerId, limit])).rows;
    return rows.map((row) => toSummary(row.record_json));
  }
  return Object.values((await readState()).sessions).filter((session) => session.playerId === playerId && session.record)
    .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt) || b.id.localeCompare(a.id)).slice(0, limit).map((session) => toSummary(session.record));
}
async function submitBoundMatch(player, season, facts) {
  const record = await readReplay(facts.replayId, player.id);
  if (!record) throw new ReplayError(404, 'Owned replay not found');
  if (!record.rewardCandidate || record.validationStatus === 'rejected') throw new ReplayError(400, 'Recording is not a completed competitive single-player match');
  if (facts.levelNumber !== record.levelNumber || facts.score !== record.claimedResult.score || facts.won !== record.claimedResult.won || facts.mode && facts.mode !== 'single') throw new ReplayError(409, 'Match claims differ from replay evidence');
  return mutateSession(record.sessionId, player.id, async (session, db) => {
    if (!session.record.rewardCandidate || session.record.validationStatus === 'rejected') throw new ReplayError(409, 'Replay was rejected before match submission');
    const matches = require('./matchResultStore');
    if (session.matchResultId) return matches.readResult(session.matchResultId, player.id);
    const result = await matches.submitResult(player, season, { ...facts, replayId: record.id });
    session.matchResultId = result.id; return result;
  });
}
// Internal integration only. Matching a client-provided map/config and external
// events proves reproducibility, not fair play; it never accepts a match/prize.
async function recordReproduction(id, evidence) {
  const record = await readReplayAdmin(id); if (!record) throw new ReplayError(404, 'Replay not found');
  if (evidence?.payloadHash !== record.payloadHash || evidence.simulationVersion !== record.replay.simulationVersion) throw new ReplayError(409, 'Verifier evidence does not match stored recording');
  if (!['matched', 'diverged', 'unsupported', 'error'].includes(evidence.status)) throw new ReplayError(400, 'Invalid reproduction outcome');
  if (evidence.status === 'matched') {
    format.validateClaim(evidence.result);
    if (format.payloadHash(evidence.result) !== format.payloadHash(record.claimedResult)) throw new ReplayError(409, 'Verifier result differs from claimed result');
  }
  return mutateSession(record.sessionId, record.playerId, async (session, db) => {
    const previous = session.record.verification.reproducibilityStatus;
    if (['matched', 'diverged'].includes(previous)) {
      if (previous !== evidence.status) throw new ReplayError(409, 'Reproduction decision is already final');
      return toSummary(session.record);
    }
    session.record.verification = { method: 'server-simulation', reproducibilityStatus: evidence.status,
      checkedAt: new Date().toISOString(), reason: typeof evidence.reason === 'string' ? evidence.reason.slice(0, 1000) : null };
    if (evidence.status === 'diverged') {
      session.record.validationStatus = 'rejected'; session.record.verificationStatus = 'rejected';
      session.record.competitiveApproval = 'rejected'; session.record.rewardCandidate = false;
      if (db) {
        await db.query("UPDATE battlecity_replays SET validation_status='rejected' WHERE id=$1 AND player_id=$2", [id, record.playerId]);
        await db.query("UPDATE battlecity_match_results SET validation_status='rejected' WHERE replay_id=$1 AND player_id=$2 AND validation_status='pending'", [id, record.playerId]);
      } else if (session.matchResultId) await require('./matchResultStore').rejectPendingReplayResult(session.matchResultId, record.playerId);
    }
    return toSummary(session.record);
  });
}
module.exports = { createSession, readSession, submitReplay, readReplay, readReplayAdmin, submitBoundMatch,
  recordReproduction, listSummaries, toSession, toSummary, isReplayId, isSessionId };
