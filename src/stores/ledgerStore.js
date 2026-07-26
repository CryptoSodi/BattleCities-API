const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const storageConfig = require('../config/storageConfig');
const database = require('../database');

// Append-only economy ledger (see docs/mattle-inspired-infrastructure-plan.md,
// "Core Data Model > Economy"). Every balance/inventory change gets an entry
// with a reason and a source, so rewards and purchases stay auditable and
// later systems (seasons, quests, airdrops) can attach their context ids.
//
// Storage follows the shared pattern: Postgres when configured, one local
// JSON file per player (array of entries) for dev/fallback.

const TABLE_NAME = 'battlecity_ledger_entries';
const MAX_LIST_LIMIT = 100;

function getDataDir() {
  return (
    process.env.BATTLECITY_LEDGER_DIR ||
    path.join(process.cwd(), 'server-data', 'ledger')
  );
}

function hasPersistentConfig() {
  return storageConfig.hasDatabaseConfig();
}

function getPgPool() {
  return database.getPool();
}

async function ensureSchema() {
  await database.assertMigrationsApplied();
}

async function ensureDataDir() {
  await fs.mkdir(getDataDir(), { recursive: true });
}

function getPlayerLedgerPath(playerId) {
  return path.join(getDataDir(), `${playerId}.json`);
}

// Records one or more entries atomically in PostgreSQL (best effort in file mode).
// Input entries: { playerId, walletAddress?, currency, amount, reason,
// sourceType, sourceId?, seasonId?, phaseId?, eventId? }.
async function appendEntries(entries) {
  const normalized = (Array.isArray(entries) ? entries : [entries])
    .map(normalizeEntry)
    .filter((entry) => entry !== null);

  if (normalized.length === 0) {
    return [];
  }

  if (hasPersistentConfig()) {
    await ensureSchema();
    return database.withTransaction(async () => {
      for (const entry of normalized) {
        await getPgPool().query(
          `
            INSERT INTO ${TABLE_NAME}
              (
                id, player_id, wallet_address, currency, amount, reason,
                source_type, source_id, season_id, phase_id, event_id,
                created_at
              )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          `,
          [
            entry.id,
            entry.playerId,
            entry.walletAddress,
            entry.currency,
            entry.amount,
            entry.reason,
            entry.sourceType,
            entry.sourceId,
            entry.seasonId,
            entry.phaseId,
            entry.eventId,
            entry.createdAt,
          ],
        );
      }
      return normalized;
    });
  }

  await ensureDataDir();

  // Entries in one appendEntries call always target one player in practice
  // (a purchase, a reward claim), but group defensively anyway.
  const byPlayer = new Map();
  for (const entry of normalized) {
    const list = byPlayer.get(entry.playerId) || [];
    list.push(entry);
    byPlayer.set(entry.playerId, list);
  }

  for (const [playerId, playerEntries] of byPlayer) {
    const existing = await readPlayerEntries(playerId);
    existing.push(...playerEntries);
    await fs.writeFile(
      getPlayerLedgerPath(playerId),
      JSON.stringify(existing),
      'utf8',
    );
  }

  return normalized;
}

async function listEntriesForPlayer(playerId, limit = 20) {
  if (!isValidPlayerId(playerId)) {
    return [];
  }

  const safeLimit = Math.max(1, Math.min(MAX_LIST_LIMIT, Number(limit) || 20));

  if (hasPersistentConfig()) {
    await ensureSchema();
    const result = await getPgPool().query(
      `
        SELECT id, player_id, wallet_address, currency, amount, reason,
          source_type, source_id, season_id, phase_id, event_id, created_at
        FROM ${TABLE_NAME}
        WHERE player_id = $1
        ORDER BY created_at DESC
        LIMIT $2
      `,
      [playerId, safeLimit],
    );

    return result.rows.map(fromRow);
  }

  const entries = await readPlayerEntries(playerId);
  return entries
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, safeLimit);
}

async function readPlayerEntries(playerId) {
  try {
    const raw = await fs.readFile(getPlayerLedgerPath(playerId), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeEntry(value) {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  if (!isValidPlayerId(value.playerId)) {
    return null;
  }

  const amount = Number(value.amount);
  if (!Number.isFinite(amount) || amount === 0) {
    return null;
  }

  return {
    id: createEntryId(),
    playerId: value.playerId,
    walletAddress:
      typeof value.walletAddress === 'string' ? value.walletAddress : null,
    currency: normalizeName(value.currency, 'token'),
    amount,
    reason: normalizeName(value.reason, 'unknown'),
    sourceType: normalizeName(value.sourceType, 'system'),
    sourceId: typeof value.sourceId === 'string' ? value.sourceId : null,
    seasonId: typeof value.seasonId === 'string' ? value.seasonId : null,
    phaseId: typeof value.phaseId === 'string' ? value.phaseId : null,
    eventId: typeof value.eventId === 'string' ? value.eventId : null,
    createdAt: new Date().toISOString(),
  };
}

function fromRow(row) {
  return {
    id: row.id,
    playerId: row.player_id,
    walletAddress: row.wallet_address,
    currency: row.currency,
    amount: Number(row.amount),
    reason: row.reason,
    sourceType: row.source_type,
    sourceId: row.source_id,
    seasonId: row.season_id,
    phaseId: row.phase_id,
    eventId: row.event_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function normalizeName(value, defaultValue) {
  if (typeof value !== 'string') {
    return defaultValue;
  }
  const trimmed = value.trim().toLowerCase();
  return /^[a-z0-9:_-]{1,64}$/.test(trimmed) ? trimmed : defaultValue;
}

function createEntryId() {
  return `led-${Date.now().toString(36)}-${crypto
    .randomBytes(8)
    .toString('hex')}`;
}

function isValidPlayerId(value) {
  return typeof value === 'string' && /^ply-[a-z0-9-]+$/i.test(value);
}

module.exports = {
  appendEntries,
  listEntriesForPlayer,
  isPersistentStoreConfigured: hasPersistentConfig,
};
