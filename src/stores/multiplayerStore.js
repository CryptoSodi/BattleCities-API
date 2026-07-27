const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const database = require('../database');
const storageConfig = require('../config/storageConfig');
const economyStore = require('./economyStore');

const MATCH_TABLE = 'battlecity_multiplayer_matches';
const PARTICIPANT_TABLE = 'battlecity_multiplayer_participants';
const EVENT_ENTRY_TABLE = 'battlecity_multiplayer_event_entries';
const SCORE_TABLE = 'battlecity_multiplayer_scores';
const APPROVAL_TABLE = 'battlecity_event_prize_approvals';
const OPEN_STATUSES = ['waiting', 'ready', 'live'];
const MAX_SCORE = 1000000;
const WAITING_MATCH_ACTIVE_MS = 10000;

let localQueue = Promise.resolve();

function hasPersistentConfig() {
  return storageConfig.hasDatabaseConfig();
}

function getPgPool() {
  return database.getPool();
}

async function ensureSchema() {
  await database.assertMigrationsApplied();
}

function getDataPath() {
  return path.join(
    process.env.BATTLECITY_MULTIPLAYER_DIR ||
      path.join(process.cwd(), 'server-data', 'multiplayer'),
    'state.json',
  );
}

async function startDirectMatch(player, fuelCost) {
  return withSerializedMatchmaking('direct', async () => {
    const abandonedMatchIds = await abandonOpenDirectMatches(player);
    const assignment = await startMatch(
      player,
      'direct',
      null,
      fuelCost,
      0,
      false,
    );
    return { ...assignment, abandonedMatchIds };
  });
}

async function enterEvent(player, event, fuelCost) {
  return withSerializedMatchmaking(`event:${event.id}`, async () => {
    const entry = await ensureEventEntry(player, event.id, fuelCost);
    return {
      created: entry.created,
      fuelCharged: entry.fuelCharged,
      account: economyStore.toPublicAccount(entry.account),
    };
  });
}

async function startEventMatch(player, event, fuelCost) {
  return withSerializedMatchmaking(`event:${event.id}`, async () =>
    startMatch(player, 'event', event.id, 0, fuelCost),
  );
}

async function startMatch(
  player,
  category,
  eventId,
  directFuelCost,
  eventFuelCost,
  reconnectExisting = true,
) {
  if (reconnectExisting) {
    const existing = await findOpenAssignment(player.id, category, eventId);
    if (existing !== null) {
      return rotateAssignmentToken(existing, true, false, 0);
    }
  }

  let eventEntryCreated = false;
  if (category === 'event') {
    const eventEntry = await ensureEventEntry(player, eventId, eventFuelCost);
    eventEntryCreated = eventEntry.created;
  }

  const openMatch = await findWaitingMatch(category, eventId, player.id);
  const matchId = openMatch?.id || createMatchId();
  const playerSlot = openMatch === null ? 0 : 1;
  const requestedFuel = category === 'direct' ? directFuelCost : 0;
  const chargedFuel = player.provider === 'guest' ? 0 : requestedFuel;

  if (requestedFuel > 0) {
    const account = await economyStore.debitFuel(player, requestedFuel, {
      reason: 'multiplayer-entry',
      sourceType: 'multiplayer-match',
      sourceId: matchId,
    });
    if (account === null) {
      throw createStoreError('INSUFFICIENT_FUEL', 'Not enough fuel');
    }
  }

  const token = createJoinToken();
  const now = new Date().toISOString();
  if (hasPersistentConfig()) {
    if (openMatch === null) {
      await getPgPool().query(
        `
          INSERT INTO ${MATCH_TABLE}
            (id, category, event_id, status, created_at, updated_at)
          VALUES ($1, $2, $3, 'waiting', $4, $4)
        `,
        [matchId, category, eventId, now],
      );
    }
    await getPgPool().query(
      `
        INSERT INTO ${PARTICIPANT_TABLE}
          (match_id, player_id, player_slot, join_token_hash,
           fuel_charged, fuel_refunded, joined_at)
        VALUES ($1, $2, $3, $4, $5, 0, $6)
      `,
      [matchId, player.id, playerSlot, hashToken(token), chargedFuel, now],
    );
    if (playerSlot === 1) {
      await getPgPool().query(
        `
          UPDATE ${MATCH_TABLE}
          SET status = 'ready', started_at = $2, updated_at = $2
          WHERE id = $1
        `,
        [matchId, now],
      );
    }
  } else {
    const state = await readLocalState();
    if (openMatch === null) {
      state.matches.push({
        id: matchId,
        category,
        eventId,
        status: 'waiting',
        broadcasterStatus: null,
        broadcasterStartedAt: null,
        broadcasterWorkerUrl: null,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        completedAt: null,
        closedAt: null,
      });
    }
    state.participants.push({
      matchId,
      playerId: player.id,
      displayName: player.displayName || 'Player',
      playerSlot,
      joinTokenHash: hashToken(token),
      fuelCharged: chargedFuel,
      fuelRefunded: 0,
      joinedAt: now,
      leftAt: null,
    });
    if (playerSlot === 1) {
      const match = state.matches.find((item) => item.id === matchId);
      match.status = 'ready';
      match.startedAt = now;
      match.updatedAt = now;
    }
    await writeLocalState(state);
  }

  return {
    match: await getMatch(matchId),
    playerSlot,
    joinToken: token,
    fuelCharged: chargedFuel,
    eventEntryCreated,
    reconnected: false,
  };
}

async function abandonOpenDirectMatches(player) {
  const now = new Date().toISOString();
  const refunds = [];
  let abandonedMatchIds = [];

  if (hasPersistentConfig()) {
    const result = await getPgPool().query(
      `
        SELECT m.id, m.status, p.fuel_charged, p.fuel_refunded
        FROM ${MATCH_TABLE} m
        JOIN ${PARTICIPANT_TABLE} p ON p.match_id = m.id
        WHERE p.player_id = $1
          AND m.category = 'direct'
          AND m.status = ANY($2::text[])
        FOR UPDATE OF m
      `,
      [player.id, OPEN_STATUSES],
    );
    abandonedMatchIds = result.rows.map((row) => row.id);
    if (abandonedMatchIds.length === 0) {
      return [];
    }
    result.rows.forEach((row) => {
      const amount = row.status === 'waiting'
        ? Math.max(0, Number(row.fuel_charged) - Number(row.fuel_refunded))
        : 0;
      if (amount > 0) {
        refunds.push({ matchId: row.id, amount });
      }
    });
    await getPgPool().query(
      `
        UPDATE ${MATCH_TABLE}
        SET status = 'closed', closed_at = $2, updated_at = $2
        WHERE id = ANY($1::text[])
      `,
      [abandonedMatchIds, now],
    );
    await getPgPool().query(
      `
        UPDATE ${PARTICIPANT_TABLE}
        SET left_at = COALESCE(left_at, $2)
        WHERE match_id = ANY($1::text[])
      `,
      [abandonedMatchIds, now],
    );
    const waitingMatchIds = refunds.map((refund) => refund.matchId);
    if (waitingMatchIds.length > 0) {
      await getPgPool().query(
        `
          UPDATE ${PARTICIPANT_TABLE}
          SET fuel_refunded = fuel_charged
          WHERE player_id = $1 AND match_id = ANY($2::text[])
        `,
        [player.id, waitingMatchIds],
      );
    }
  } else {
    const state = await readLocalState();
    abandonedMatchIds = state.matches
      .filter((match) => {
        return (
          match.category === 'direct' &&
          OPEN_STATUSES.includes(match.status) &&
          state.participants.some(
            (participant) =>
              participant.matchId === match.id &&
              participant.playerId === player.id,
          )
        );
      })
      .map((match) => match.id);
    if (abandonedMatchIds.length === 0) {
      return [];
    }
    state.matches
      .filter((match) => abandonedMatchIds.includes(match.id))
      .forEach((match) => {
        const participant = state.participants.find(
          (item) =>
            item.matchId === match.id && item.playerId === player.id,
        );
        const amount = match.status === 'waiting'
          ? Math.max(
            0,
            participant.fuelCharged - participant.fuelRefunded,
          )
          : 0;
        if (amount > 0) {
          participant.fuelRefunded += amount;
          refunds.push({ matchId: match.id, amount });
        }
        match.status = 'closed';
        match.closedAt = now;
        match.updatedAt = now;
      });
    state.participants
      .filter((participant) =>
        abandonedMatchIds.includes(participant.matchId),
      )
      .forEach((participant) => {
        participant.leftAt = participant.leftAt || now;
      });
    await writeLocalState(state);
  }

  for (const refund of refunds) {
    await economyStore.creditFuel(player, refund.amount, {
      reason: 'multiplayer-refund',
      sourceType: 'multiplayer-match',
      sourceId: refund.matchId,
    });
  }
  return abandonedMatchIds;
}

async function ensureEventEntry(player, eventId, fuelCost) {
  const existing = await readEventEntry(eventId, player.id);
  if (existing !== null) {
    return {
      created: false,
      fuelCharged: 0,
      account: await economyStore.ensureAccountForPlayer(player),
    };
  }

  const requestedFuel = Math.max(0, Math.floor(Number(fuelCost) || 0));
  const chargedFuel = player.provider === 'guest' ? 0 : requestedFuel;
  let account = await economyStore.ensureAccountForPlayer(player);
  if (requestedFuel > 0) {
    account = await economyStore.debitFuel(player, requestedFuel, {
      reason: 'event-entry',
      sourceType: 'multiplayer-event',
      sourceId: eventId,
      eventId,
    });
    if (account === null) {
      throw createStoreError('INSUFFICIENT_FUEL', 'Not enough fuel');
    }
  }

  const now = new Date().toISOString();
  if (hasPersistentConfig()) {
    await getPgPool().query(
      `
        INSERT INTO ${EVENT_ENTRY_TABLE}
          (event_id, player_id, fuel_cost, entered_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (event_id, player_id) DO NOTHING
      `,
      [eventId, player.id, chargedFuel, now],
    );
  } else {
    const state = await readLocalState();
    state.eventEntries.push({
      eventId,
      playerId: player.id,
      fuelCost: chargedFuel,
      enteredAt: now,
    });
    await writeLocalState(state);
  }

  return { created: true, fuelCharged: chargedFuel, account };
}

async function exitMatch(player, matchId) {
  return withSerializedMatchmaking(`exit:${matchId}`, async () => {
    const assignment = await findAssignment(player.id, matchId);
    if (assignment === null) {
      return { ok: false, error: 'Match membership not found' };
    }
    if (assignment.match.status !== 'waiting') {
      return { ok: false, error: 'Match already started' };
    }

    const refundable =
      assignment.match.category === 'direct'
        ? Math.max(0, assignment.fuelCharged - assignment.fuelRefunded)
        : 0;
    const now = new Date().toISOString();

    if (hasPersistentConfig()) {
      await getPgPool().query(
        `
          UPDATE ${MATCH_TABLE}
          SET status = 'closed', closed_at = $2, updated_at = $2
          WHERE id = $1
        `,
        [matchId, now],
      );
      await getPgPool().query(
        `
          UPDATE ${PARTICIPANT_TABLE}
          SET fuel_refunded = fuel_refunded + $3, left_at = $4
          WHERE match_id = $1 AND player_id = $2
        `,
        [matchId, player.id, refundable, now],
      );
    } else {
      const state = await readLocalState();
      const match = state.matches.find((item) => item.id === matchId);
      const participant = state.participants.find(
        (item) => item.matchId === matchId && item.playerId === player.id,
      );
      match.status = 'closed';
      match.closedAt = now;
      match.updatedAt = now;
      participant.fuelRefunded += refundable;
      participant.leftAt = now;
      await writeLocalState(state);
    }

    if (refundable > 0) {
      await economyStore.creditFuel(player, refundable, {
        reason: 'multiplayer-refund',
        sourceType: 'multiplayer-match',
        sourceId: matchId,
      });
    }

    return { ok: true, refundedFuel: refundable, match: await getMatch(matchId) };
  });
}

async function reconnect(player, matchId) {
  return withSerializedMatchmaking(`reconnect:${matchId}`, async () => {
    const assignment = await findAssignment(player.id, matchId);
    if (assignment === null || !OPEN_STATUSES.includes(assignment.match.status)) {
      return null;
    }
    if (assignment.match.status === 'waiting') {
      await touchWaitingMatch(matchId);
    }
    return rotateAssignmentToken(assignment, true, false, 0);
  });
}

async function touchWaitingMatch(matchId) {
  const now = new Date().toISOString();
  if (hasPersistentConfig()) {
    await getPgPool().query(
      `
        UPDATE ${MATCH_TABLE}
        SET updated_at = $2
        WHERE id = $1 AND status = 'waiting'
      `,
      [matchId, now],
    );
    return;
  }
  const state = await readLocalState();
  const match = state.matches.find((item) => item.id === matchId);
  if (match?.status === 'waiting') {
    match.updatedAt = now;
    await writeLocalState(state);
  }
}

async function markStarted(player, matchId) {
  const assignment = await findAssignment(player.id, matchId);
  if (assignment === null) {
    return null;
  }
  const now = new Date().toISOString();
  if (hasPersistentConfig()) {
    await ensureSchema();
    await getPgPool().query(
      `
        UPDATE ${MATCH_TABLE}
        SET status = 'live', started_at = COALESCE(started_at, $2), updated_at = $2
        WHERE id = $1 AND status = 'ready'
      `,
      [matchId, now],
    );
  } else {
    await withLocalLock(async () => {
      const state = await readLocalState();
      const match = state.matches.find((item) => item.id === matchId);
      if (match?.status === 'ready') {
        match.status = 'live';
        match.startedAt = match.startedAt || now;
        match.updatedAt = now;
        await writeLocalState(state);
      }
    });
  }
  return getMatch(matchId);
}

async function getBroadcasterState(matchId) {
  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `SELECT broadcaster_status, broadcaster_started_at, broadcaster_worker_url
       FROM ${MATCH_TABLE} WHERE id = $1`,
      [matchId],
    );
    if (result.rowCount === 0) {
      return null;
    }
    const row = result.rows[0];
    return {
      status: row.broadcaster_status,
      startedAt: row.broadcaster_started_at
        ? new Date(row.broadcaster_started_at).toISOString()
        : null,
      workerUrl: row.broadcaster_worker_url,
    };
  }
  const state = await readLocalState();
  const match = state.matches.find((item) => item.id === matchId);
  return match === undefined
    ? null
    : {
        status: match.broadcasterStatus || null,
        startedAt: match.broadcasterStartedAt || null,
        workerUrl: match.broadcasterWorkerUrl || null,
      };
}

async function setBroadcasterState(matchId, status, workerUrl = null) {
  const startedAt = status === 'running' ? new Date().toISOString() : null;
  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `UPDATE ${MATCH_TABLE}
       SET broadcaster_status = $2,
           broadcaster_started_at = CASE
             WHEN $2 = 'running' THEN COALESCE(broadcaster_started_at, $3)
             ELSE broadcaster_started_at
           END,
           broadcaster_worker_url = COALESCE($4, broadcaster_worker_url),
           updated_at = $3
       WHERE id = $1
       RETURNING id`,
      [matchId, status, startedAt || new Date().toISOString(), workerUrl],
    );
    return result.rowCount > 0;
  }
  return withLocalLock(async () => {
    const state = await readLocalState();
    const match = state.matches.find((item) => item.id === matchId);
    if (match === undefined) {
      return false;
    }
    match.broadcasterStatus = status;
    if (status === 'running') {
      match.broadcasterStartedAt = match.broadcasterStartedAt || startedAt;
    }
    if (workerUrl !== null) {
      match.broadcasterWorkerUrl = workerUrl;
    }
    match.updatedAt = new Date().toISOString();
    await writeLocalState(state);
    return true;
  });
}

async function authorizePlayerJoin(playerId, matchId, playerSlot, token) {
  if (
    !Number.isInteger(playerSlot) ||
    ![0, 1].includes(playerSlot) ||
    typeof token !== 'string' ||
    token.length === 0
  ) {
    return false;
  }
  const tokenHash = hashToken(token);
  let storedHash = null;
  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `SELECT join_token_hash FROM ${PARTICIPANT_TABLE}
       WHERE match_id = $1 AND player_id = $2 AND player_slot = $3`,
      [matchId, playerId, playerSlot],
    );
    storedHash = result.rowCount === 0 ? null : result.rows[0].join_token_hash;
  } else {
    const state = await readLocalState();
    storedHash = state.participants.find(
      (item) =>
        item.matchId === matchId &&
        item.playerId === playerId &&
        item.playerSlot === playerSlot,
    )?.joinTokenHash;
  }
  return safeHashEquals(storedHash, tokenHash);
}

async function completeAuthoritativeMatch(matchId, scores) {
  return withSerializedMatchmaking(`result:${matchId}`, async () => {
    const match = await getMatch(matchId);
    if (match === null || match.players.length !== 2) {
      return null;
    }
    if (match.status === 'completed') {
      return match;
    }
    const normalizedScores = normalizeAuthoritativeScores(scores);
    const now = new Date().toISOString();
    if (hasPersistentConfig()) {
      for (const entry of normalizedScores) {
        const participant = match.players.find((item) => item.slot === entry.playerSlot);
        await getPgPool().query(
          `INSERT INTO ${SCORE_TABLE}
             (match_id, event_id, player_id, score, validation_status,
              created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'accepted', $5, $5)
           ON CONFLICT (match_id, player_id) DO UPDATE SET
             score = EXCLUDED.score,
             validation_status = 'accepted',
             updated_at = EXCLUDED.updated_at`,
          [matchId, match.eventId, participant.playerId, entry.score, now],
        );
      }
      await getPgPool().query(
        `UPDATE ${MATCH_TABLE}
         SET status = 'completed', completed_at = COALESCE(completed_at, $2),
             updated_at = $2
         WHERE id = $1`,
        [matchId, now],
      );
    } else {
      const state = await readLocalState();
      for (const entry of normalizedScores) {
        const participant = state.participants.find(
          (item) => item.matchId === matchId && item.playerSlot === entry.playerSlot,
        );
        const existing = state.scores.find(
          (item) => item.matchId === matchId && item.playerId === participant.playerId,
        );
        const score = {
          matchId,
          eventId: match.eventId,
          playerId: participant.playerId,
          displayName: participant.displayName || 'Player',
          provider: participant.provider,
          score: entry.score,
          validationStatus: 'accepted',
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        };
        if (existing === undefined) {
          state.scores.push(score);
        } else {
          Object.assign(existing, score);
        }
      }
      const localMatch = state.matches.find((item) => item.id === matchId);
      localMatch.status = 'completed';
      localMatch.completedAt = localMatch.completedAt || now;
      localMatch.updatedAt = now;
      await writeLocalState(state);
    }
    return getMatch(matchId);
  });
}

async function submitScore(player, matchId, score) {
  const safeScore = clampInteger(score, 0, MAX_SCORE);
  return withSerializedMatchmaking(`score:${matchId}`, async () => {
    const assignment = await findAssignment(player.id, matchId);
    if (assignment === null) {
      return null;
    }
    if (
      !['ready', 'live'].includes(assignment.match.status) ||
      assignment.match.players.length !== 2
    ) {
      throw createStoreError('MATCH_NOT_STARTED', 'Match has not started');
    }

    const now = new Date().toISOString();
    let recordedScore = safeScore;
    if (hasPersistentConfig()) {
      const saved = await getPgPool().query(
        `
          INSERT INTO ${SCORE_TABLE}
            (match_id, event_id, player_id, score, validation_status,
             created_at, updated_at)
          VALUES ($1, $2, $3, $4, 'pending', $5, $5)
          ON CONFLICT (match_id, player_id) DO UPDATE SET
            score = GREATEST(${SCORE_TABLE}.score, EXCLUDED.score),
            updated_at = EXCLUDED.updated_at
          RETURNING score
        `,
        [matchId, assignment.match.eventId, player.id, safeScore, now],
      );
      recordedScore = Number(saved.rows[0].score);
      const counts = await getPgPool().query(
        `
          SELECT
            (SELECT COUNT(*) FROM ${PARTICIPANT_TABLE} WHERE match_id = $1) AS players,
            (SELECT COUNT(*) FROM ${SCORE_TABLE} WHERE match_id = $1) AS scores
        `,
        [matchId],
      );
      if (Number(counts.rows[0].scores) >= Number(counts.rows[0].players)) {
        await getPgPool().query(
          `
            UPDATE ${MATCH_TABLE}
            SET status = 'completed', completed_at = $2, updated_at = $2
            WHERE id = $1
          `,
          [matchId, now],
        );
      }
    } else {
      const state = await readLocalState();
      const existing = state.scores.find(
        (item) => item.matchId === matchId && item.playerId === player.id,
      );
      if (existing === undefined) {
        state.scores.push({
          matchId,
          eventId: assignment.match.eventId,
          playerId: player.id,
          displayName: player.displayName || 'Player',
          provider: player.provider,
          score: safeScore,
          validationStatus: 'pending',
          createdAt: now,
          updatedAt: now,
        });
      } else {
        existing.score = Math.max(existing.score, safeScore);
        existing.updatedAt = now;
        recordedScore = existing.score;
      }
      const playerCount = state.participants.filter(
        (item) => item.matchId === matchId,
      ).length;
      const scoreCount = state.scores.filter((item) => item.matchId === matchId).length;
      if (scoreCount >= playerCount) {
        const match = state.matches.find((item) => item.id === matchId);
        match.status = 'completed';
        match.completedAt = now;
        match.updatedAt = now;
      }
      await writeLocalState(state);
    }

    return { score: recordedScore, match: await getMatch(matchId) };
  });
}

async function getEventLeaderboard(eventId, limit = 100) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 100));
  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `
        WITH best AS (
          SELECT s.player_id,
            MAX(p.display_name) AS display_name,
            MAX(s.score)::int AS score,
            COUNT(*)::int AS matches
          FROM ${SCORE_TABLE} s
          JOIN battlecity_players p ON p.id = s.player_id
          WHERE s.event_id = $1
            AND s.validation_status = 'accepted'
            AND p.provider <> 'guest'
          GROUP BY s.player_id
        )
        SELECT (RANK() OVER (ORDER BY score DESC))::int AS rank,
          player_id, display_name, score, matches
        FROM best
        ORDER BY score DESC, player_id ASC
        LIMIT $2
      `,
      [eventId, safeLimit],
    );
    return result.rows.map((row) => ({
      rank: Number(row.rank),
      playerId: row.player_id,
      displayName: row.display_name,
      score: Number(row.score),
      matches: Number(row.matches),
    }));
  }

  const state = await readLocalState();
  const best = new Map();
  state.scores
    .filter(
      (item) =>
        item.eventId === eventId &&
        item.validationStatus === 'accepted' &&
        item.provider !== 'guest',
    )
    .forEach((item) => {
      const existing = best.get(item.playerId);
      if (existing === undefined) {
        best.set(item.playerId, {
          playerId: item.playerId,
          displayName: item.displayName,
          score: item.score,
          matches: 1,
        });
      } else {
        existing.score = Math.max(existing.score, item.score);
        existing.matches += 1;
      }
    });
  const rows = Array.from(best.values()).sort(
    (a, b) => b.score - a.score || a.playerId.localeCompare(b.playerId),
  );
  let rank = 0;
  let previousScore = null;
  return rows.slice(0, safeLimit).map((row, index) => {
    if (row.score !== previousScore) {
      rank = index + 1;
      previousScore = row.score;
    }
    return { rank, ...row };
  });
}

async function approveEventPrizes(eventId, allocations) {
  const normalized = normalizeAllocations(allocations);
  const now = new Date().toISOString();
  if (hasPersistentConfig()) {
    await ensureSchema();
    await getPgPool().query(
      `
        INSERT INTO ${APPROVAL_TABLE} (event_id, allocations_json, approved_at)
        VALUES ($1, $2::jsonb, $3)
        ON CONFLICT (event_id) DO UPDATE SET
          allocations_json = EXCLUDED.allocations_json,
          approved_at = EXCLUDED.approved_at
      `,
      [eventId, JSON.stringify(normalized), now],
    );
  } else {
    await withLocalLock(async () => {
      const state = await readLocalState();
      state.approvals[eventId] = { allocations: normalized, approvedAt: now };
      await writeLocalState(state);
    });
  }
  return { eventId, allocations: normalized, approvedAt: now };
}

async function listOpenMatches() {
  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `SELECT id FROM ${MATCH_TABLE}
       WHERE status = ANY($1::text[])
       ORDER BY created_at ASC`,
      [OPEN_STATUSES],
    );
    return Promise.all(result.rows.map((row) => getMatch(row.id)));
  }
  const state = await readLocalState();
  return state.matches
    .filter((match) => OPEN_STATUSES.includes(match.status))
    .map((match) => toPublicLocalMatch(state, match));
}

async function getMatch(matchId) {
  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `
        SELECT m.id, m.category, m.event_id, m.status, m.created_at,
          m.started_at, m.completed_at, p.player_id, p.player_slot,
          players.display_name
        FROM ${MATCH_TABLE} m
        LEFT JOIN ${PARTICIPANT_TABLE} p ON p.match_id = m.id
        LEFT JOIN battlecity_players players ON players.id = p.player_id
        WHERE m.id = $1
        ORDER BY p.player_slot ASC
      `,
      [matchId],
    );
    if (result.rowCount === 0) {
      return null;
    }
    return toPublicDatabaseMatch(result.rows);
  }
  const state = await readLocalState();
  const match = state.matches.find((item) => item.id === matchId);
  return match === undefined ? null : toPublicLocalMatch(state, match);
}

async function findOpenAssignment(playerId, category, eventId) {
  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `
        SELECT p.match_id, p.player_slot, p.fuel_charged, p.fuel_refunded
        FROM ${PARTICIPANT_TABLE} p
        JOIN ${MATCH_TABLE} m ON m.id = p.match_id
        WHERE p.player_id = $1 AND m.category = $2
          AND m.event_id IS NOT DISTINCT FROM $3
          AND m.status = ANY($4::text[])
        ORDER BY p.joined_at DESC
        LIMIT 1
      `,
      [playerId, category, eventId, OPEN_STATUSES],
    );
    if (result.rowCount === 0) {
      return null;
    }
    return assignmentFromRow(result.rows[0]);
  }
  const state = await readLocalState();
  const participant = [...state.participants].reverse().find((item) => {
    const match = state.matches.find((candidate) => candidate.id === item.matchId);
    return (
      item.playerId === playerId &&
      match?.category === category &&
      match?.eventId === eventId &&
      OPEN_STATUSES.includes(match.status)
    );
  });
  return participant === undefined ? null : assignmentFromLocal(state, participant);
}

async function findAssignment(playerId, matchId) {
  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `
        SELECT match_id, player_slot, fuel_charged, fuel_refunded
        FROM ${PARTICIPANT_TABLE}
        WHERE player_id = $1 AND match_id = $2
        LIMIT 1
      `,
      [playerId, matchId],
    );
    return result.rowCount === 0 ? null : assignmentFromRow(result.rows[0]);
  }
  const state = await readLocalState();
  const participant = state.participants.find(
    (item) => item.playerId === playerId && item.matchId === matchId,
  );
  return participant === undefined ? null : assignmentFromLocal(state, participant);
}

async function assignmentFromRow(row) {
  return {
    match: await getMatch(row.match_id),
    playerSlot: Number(row.player_slot),
    fuelCharged: Number(row.fuel_charged),
    fuelRefunded: Number(row.fuel_refunded),
  };
}

function assignmentFromLocal(state, participant) {
  const match = state.matches.find((item) => item.id === participant.matchId);
  return {
    match: toPublicLocalMatch(state, match),
    playerSlot: participant.playerSlot,
    fuelCharged: participant.fuelCharged,
    fuelRefunded: participant.fuelRefunded,
  };
}

async function rotateAssignmentToken(
  assignment,
  reconnected,
  eventEntryCreated,
  fuelCharged,
) {
  const token = createJoinToken();
  if (hasPersistentConfig()) {
    await getPgPool().query(
      `UPDATE ${PARTICIPANT_TABLE} SET join_token_hash = $3
       WHERE match_id = $1 AND player_slot = $2`,
      [assignment.match.id, assignment.playerSlot, hashToken(token)],
    );
  } else {
    const state = await readLocalState();
    const participant = state.participants.find(
      (item) =>
        item.matchId === assignment.match.id &&
        item.playerSlot === assignment.playerSlot,
    );
    participant.joinTokenHash = hashToken(token);
    await writeLocalState(state);
  }
  return {
    match: assignment.match,
    playerSlot: assignment.playerSlot,
    joinToken: token,
    fuelCharged,
    eventEntryCreated,
    reconnected,
  };
}

async function findWaitingMatch(category, eventId, excludedPlayerId) {
  const activeAfter = new Date(
    Date.now() - WAITING_MATCH_ACTIVE_MS,
  ).toISOString();
  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `
        SELECT m.id
        FROM ${MATCH_TABLE} m
        WHERE m.category = $1
          AND m.event_id IS NOT DISTINCT FROM $2
          AND m.status = 'waiting'
          AND (
            m.category <> 'direct' OR
            m.updated_at >= $4
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${PARTICIPANT_TABLE} p
            WHERE p.match_id = m.id AND p.player_id = $3
          )
        ORDER BY m.created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `,
      [category, eventId, excludedPlayerId, activeAfter],
    );
    return result.rowCount === 0 ? null : { id: result.rows[0].id };
  }
  const state = await readLocalState();
  const activeAfterTimestamp = Date.parse(activeAfter);
  return (
    state.matches.find(
      (match) =>
        match.category === category &&
        match.eventId === eventId &&
        match.status === 'waiting' &&
        (
          match.category !== 'direct' ||
          Date.parse(match.updatedAt) >= activeAfterTimestamp
        ) &&
        !state.participants.some(
          (item) => item.matchId === match.id && item.playerId === excludedPlayerId,
        ),
    ) || null
  );
}

async function readEventEntry(eventId, playerId) {
  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `SELECT event_id, player_id, fuel_cost, entered_at
       FROM ${EVENT_ENTRY_TABLE} WHERE event_id = $1 AND player_id = $2`,
      [eventId, playerId],
    );
    return result.rowCount === 0 ? null : result.rows[0];
  }
  const state = await readLocalState();
  return (
    state.eventEntries.find(
      (entry) => entry.eventId === eventId && entry.playerId === playerId,
    ) || null
  );
}

async function withSerializedMatchmaking(key, operation) {
  if (!hasPersistentConfig()) {
    return withLocalLock(operation);
  }
  await ensureSchema();
  return database.withTransaction(async () => {
    await getPgPool().query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `battlecities:multiplayer:${key}`,
    ]);
    return operation();
  });
}

function withLocalLock(operation) {
  const pending = localQueue.then(operation, operation);
  localQueue = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

async function readLocalState() {
  try {
    return normalizeLocalState(
      JSON.parse(await fs.readFile(getDataPath(), 'utf8')),
    );
  } catch {
    return normalizeLocalState({});
  }
}

async function writeLocalState(state) {
  await fs.mkdir(path.dirname(getDataPath()), { recursive: true });
  await fs.writeFile(getDataPath(), JSON.stringify(state), 'utf8');
}

function normalizeLocalState(value) {
  return {
    matches: Array.isArray(value.matches) ? value.matches : [],
    participants: Array.isArray(value.participants) ? value.participants : [],
    eventEntries: Array.isArray(value.eventEntries) ? value.eventEntries : [],
    scores: Array.isArray(value.scores) ? value.scores : [],
    approvals:
      typeof value.approvals === 'object' && value.approvals !== null
        ? value.approvals
        : {},
  };
}

function toPublicDatabaseMatch(rows) {
  const first = rows[0];
  return {
    id: first.id,
    category: first.category,
    eventId: first.event_id,
    status: first.status,
    players: rows
      .filter((row) => row.player_id !== null)
      .map((row) => ({
        playerId: row.player_id,
        displayName: row.display_name || 'Player',
        slot: Number(row.player_slot),
      })),
    createdAt: new Date(first.created_at).toISOString(),
    startedAt: first.started_at ? new Date(first.started_at).toISOString() : null,
    completedAt: first.completed_at
      ? new Date(first.completed_at).toISOString()
      : null,
  };
}

function toPublicLocalMatch(state, match) {
  return {
    id: match.id,
    category: match.category,
    eventId: match.eventId,
    status: match.status,
    players: state.participants
      .filter((participant) => participant.matchId === match.id)
      .sort((a, b) => a.playerSlot - b.playerSlot)
      .map((participant) => ({
        playerId: participant.playerId,
        displayName: participant.displayName,
        slot: participant.playerSlot,
      })),
    createdAt: match.createdAt,
    startedAt: match.startedAt,
    completedAt: match.completedAt,
  };
}

function normalizeAllocations(allocations) {
  if (!Array.isArray(allocations) || allocations.length === 0) {
    throw createStoreError('INVALID_ALLOCATIONS', 'Prize allocations are required');
  }
  return allocations.map((allocation) => {
    const playerId = String(allocation?.playerId || '');
    const rank = Math.floor(Number(allocation?.rank));
    const amount = Number(allocation?.amount);
    const currency = String(allocation?.currency || '').trim();
    if (
      !/^ply-[a-z0-9-]+$/i.test(playerId) ||
      !Number.isInteger(rank) ||
      rank < 1 ||
      !Number.isFinite(amount) ||
      amount < 0 ||
      currency === ''
    ) {
      throw createStoreError('INVALID_ALLOCATIONS', 'Invalid prize allocation');
    }
    return { playerId, rank, amount, currency };
  });
}

function createMatchId() {
  return `match-${crypto.randomBytes(12).toString('hex')}`;
}

function createJoinToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function safeHashEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') {
    return false;
  }
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function normalizeAuthoritativeScores(scores) {
  if (!Array.isArray(scores) || scores.length !== 2) {
    throw createStoreError('INVALID_RESULT', 'Two player scores are required');
  }
  const normalized = scores.map((entry) => {
    const playerSlot = Number(entry?.playerSlot);
    const score = Number(entry?.score);
    if (
      !Number.isInteger(score) ||
      score < 0 ||
      score > MAX_SCORE
    ) {
      throw createStoreError('INVALID_RESULT', 'Invalid authoritative score');
    }
    return { playerSlot, score };
  });
  if (
    normalized.some((entry) => ![0, 1].includes(entry.playerSlot)) ||
    new Set(normalized.map((entry) => entry.playerSlot)).size !== 2
  ) {
    throw createStoreError('INVALID_RESULT', 'Scores must contain player slots 0 and 1');
  }
  return normalized;
}

function clampInteger(value, min, max) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : min;
}

function createStoreError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  authorizePlayerJoin,
  approveEventPrizes,
  completeAuthoritativeMatch,
  enterEvent,
  exitMatch,
  getBroadcasterState,
  getEventLeaderboard,
  getMatch,
  listOpenMatches,
  markStarted,
  reconnect,
  setBroadcasterState,
  startDirectMatch,
  startEventMatch,
  isPersistentStoreConfigured: hasPersistentConfig,
};
