const storageConfig = require('../config/storageConfig');

// Phases are long-running reward windows that may span multiple seasons
// (plan: "Ranking, Seasons, Phases"). They are static config records for now
// — phase reward distribution arrives with the airdrop/allocation milestone,
// so no per-player state lives here yet.

const PHASE_DEFINITIONS = [
  {
    id: 'phase-1',
    number: 1,
    name: 'PHASE 1',
    startsAt: '2026-07-01T00:00:00.000Z',
    endsAt: '2026-12-31T00:00:00.000Z',
    rewardPool: '1M BACT',
  },
];

function listPhases() {
  return PHASE_DEFINITIONS.map(toPublicPhase);
}

function toPublicPhase(phase) {
  const now = Date.now();
  let status = 'live';
  if (now < Date.parse(phase.startsAt)) {
    status = 'upcoming';
  } else if (now >= Date.parse(phase.endsAt)) {
    status = 'ended';
  }

  return {
    id: phase.id,
    number: phase.number,
    name: phase.name,
    startsAt: phase.startsAt,
    endsAt: phase.endsAt,
    status,
    rewardPool: phase.rewardPool,
  };
}

module.exports = {
  listPhases,
  isPersistentStoreConfigured: storageConfig.hasDatabaseConfig,
};
