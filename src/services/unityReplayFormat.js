const crypto = require('node:crypto');
const FORMAT = 'battlecities-unity-input-v1';
const LIMITS = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxTicks: 108000, maxCheckpoints: 1801, maxEvents: 4096, maxInputs: 108000 });
const POWERS = new Set(['shield', 'upgrade', 'speed', 'life', 'freeze', 'wipeout', 'zoomout', 'defence', 'healmax', 'heal2', 'rapid', 'rapidlong']);
const MODES = new Set(['single', 'coop', 'versus']);
const HASH = /^[a-f0-9]{64}$/;

class ReplayError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const invalid = (message) => { throw new ReplayError(400, message); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const number = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
function onlyKeys(value, keys, label) {
  if (!object(value) || Object.keys(value).some((key) => !keys.includes(key))) invalid(`Invalid ${label} fields`);
}
function validateSessionInput(value) {
  onlyKeys(value, ['simulationVersion', 'buildVersion', 'levelNumber', 'levelHash', 'configHash', 'tickRate', 'mode'], 'session');
  if (value.simulationVersion !== 'unity-sim-v1') invalid('Unsupported simulation version');
  if (typeof value.buildVersion !== 'string' || !/^[A-Za-z0-9._+-]{1,64}$/.test(value.buildVersion)) invalid('Invalid build version');
  if (!integer(value.levelNumber, 1, 35) || value.tickRate !== 60 || !MODES.has(value.mode)) invalid('Invalid level, mode or tick rate');
  if (!HASH.test(value.levelHash) || !HASH.test(value.configHash)) invalid('Invalid content hash');
  return { simulationVersion: value.simulationVersion, buildVersion: value.buildVersion, levelNumber: value.levelNumber,
    levelHash: value.levelHash, configHash: value.configHash, tickRate: value.tickRate, mode: value.mode };
}
function validateJsonTree(value) {
  let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 40000 || depth > 20) invalid('Map/config is too complex');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!number(item, -1000000, 1000000)) invalid('Invalid map/config number'); return; }
    if (typeof item === 'string') { if (item.length > 256) invalid('Map/config string is too long'); return; }
    if (Array.isArray(item)) { if (item.length > 4096) invalid('Map/config array is too long'); item.forEach((child) => visit(child, depth + 1)); return; }
    if (!object(item)) invalid('Invalid map/config value');
    for (const [key, child] of Object.entries(item)) {
      if (key.length > 64 || ['__proto__', 'constructor', 'prototype'].includes(key)) invalid('Invalid map/config key');
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}
function validateMap(map) {
  if (!object(map) || !object(map.field) || !integer(map.field.widthTiles, 4, 64) || !integer(map.field.heightTiles, 4, 64)) invalid('Invalid map dimensions');
  let terrainCells = 0;
  for (const group of [map.terrain, map.ground]) {
    if (group == null || group.regions == null) continue;
    if (!Array.isArray(group.regions) || group.regions.length > 512) invalid('Too many map regions');
    for (const region of group.regions) {
      if (!object(region) || typeof region.type !== 'string' || region.type.length > 64 ||
        !number(region.width, 0, 4096) || !number(region.height, 0, 4096) || !number(region.x, -8192, 8192) || !number(region.y, -8192, 8192)) invalid('Invalid map region');
      terrainCells += (Math.ceil(region.width / 32) + 1) * (Math.ceil(region.height / 32) + 1);
    }
  }
  if (terrainCells > 20000) invalid('Map terrain exceeds simulation bounds');
  for (const [key, max] of [['objects', 2048], ['lights', 128]]) {
    if (map[key] != null && (!Array.isArray(map[key]) || map[key].length > max)) invalid(`Invalid map ${key}`);
  }
  for (const item of map.objects || []) {
    if (!object(item) || !number(item.x, -8192, 8192) || !number(item.y, -8192, 8192) ||
      !number(item.width, 0, 4096) || !number(item.height, 0, 4096) || !number(item.rotation, -36000, 36000)) invalid('Invalid map object dimensions');
  }
  for (const group of [map.spawn?.enemy, map.spawn?.player]) {
    if (group?.locations != null && (!Array.isArray(group.locations) || group.locations.length > 32)) invalid('Invalid spawn locations');
    if (group?.list != null && (!Array.isArray(group.list) || group.list.length > 512)) invalid('Invalid spawn list');
    for (const point of group?.locations || []) {
      if (!object(point) || !number(point.x, -8192, 8192) || !number(point.y, -8192, 8192)) invalid('Invalid spawn point');
    }
    for (const enemy of group?.list || []) {
      if (!object(enemy) || typeof enemy.tier !== 'string' || enemy.tier.length > 32 || typeof enemy.drop !== 'boolean') invalid('Invalid enemy specification');
    }
  }
}
function validateConfig(config) {
  if (config?.powerupRosterVersion !== undefined && !integer(config.powerupRosterVersion, 0, 1)) invalid('Unsupported power-up roster version');
  if (config?.wipeoutDamageVersion !== undefined && !integer(config.wipeoutDamageVersion, 0, 1)) invalid('Unsupported Wipeout damage version');
  if (config?.tankStatsVersion !== undefined && !integer(config.tankStatsVersion, 0, 1)) invalid('Unsupported tank stats version');
  if (!object(config) || !integer(config.playerTier, 0, 3) || !object(config.landDrone)) invalid('Invalid simulation config');
  for (const key of ['normalReload', 'upgradedReload', 'turretCooldown', 'turretReload']) {
    if (!number(config[key], 0.001, 60)) invalid(`Invalid config ${key}`);
  }
  for (const [key, min, max] of [['turretRange', 1, 8192], ['turretTurn', 0, 60], ['turretMuzzle', 0, 2048], ['turretDeploy', 0, 60]]) {
    if (!number(config[key], min, max)) invalid(`Invalid config ${key}`);
  }
  if (!integer(config.turretDamage, 1, 1000) || !integer(config.turretHealth, 1, 1000)) invalid('Invalid turret damage/health');
  const droneLimits = { PatrolSpeedMultiplier: [0, 20], SightAngleDegrees: [0, 360], SpeedMultiplier: [0, 20], DetectionTiles: [0, 64],
    Lifetime: [0, 1800], RouteTimeout: [0, 300], RepathSeconds: [0.001, 60], Acceleration: [0, 10000], SplashTiles: [0, 64],
    Health: [0, 1000], DirectDamage: [0, 1000], SplashDamage: [0, 1000] };
  for (const [key, value] of Object.entries(config.landDrone)) {
    const bounds = droneLimits[key];
    if (!bounds || !number(value, ...bounds) || ['Health', 'DirectDamage', 'SplashDamage'].includes(key) && !Number.isInteger(value)) invalid('Invalid land drone config');
  }
}
function validateClaim(value) {
  onlyKeys(value, ['score', 'lives', 'remaining', 'won', 'lost', 'winnerSlot'], 'claimed result');
  if (!integer(value.score, 0, 1000000) || !integer(value.lives, 0, 1000) || !integer(value.remaining, 0, 1000) ||
      typeof value.won !== 'boolean' || typeof value.lost !== 'boolean' || value.won && value.lost || !integer(value.winnerSlot, -1, 3)) invalid('Invalid claimed result');
}
function validateReplay(value) {
  onlyKeys(value, ['format', 'simulationVersion', 'buildVersion', 'id', 'createdAt', 'seed', 'levelNumber', 'levelHash', 'tickRate', 'durationTicks',
    'mode', 'map', 'config', 'configHash', 'inputs', 'events', 'checkpoints', 'claimedResult', 'completion', 'debugUsed'], 'replay');
  if (value.format !== FORMAT) invalid('Unsupported replay format');
  validateSessionInput(Object.fromEntries(['simulationVersion', 'buildVersion', 'levelNumber', 'levelHash', 'configHash', 'tickRate', 'mode'].map((key) => [key, value[key]])));
  if (typeof value.id !== 'string' || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value.id)) invalid('Invalid replay client ID');
  if (typeof value.createdAt !== 'string' || value.createdAt.length > 40 || !Number.isFinite(Date.parse(value.createdAt))) invalid('Invalid replay timestamp');
  if (!integer(value.seed, 1, 0xffffffff) || !integer(value.durationTicks, 1, LIMITS.maxTicks)) invalid('Invalid seed or duration');
  if (!['completed', 'aborted', 'truncated'].includes(value.completion) || typeof value.debugUsed !== 'boolean') invalid('Invalid recording completion state');
  validateJsonTree({ map: value.map, config: value.config }); validateMap(value.map); validateConfig(value.config); validateClaim(value.claimedResult);
  if (value.completion === 'completed' && !value.claimedResult.won && !value.claimedResult.lost) invalid('Completed replay has no terminal outcome');
  if (!Array.isArray(value.inputs) || value.inputs.length < 1 || value.inputs.length > LIMITS.maxInputs) invalid('Invalid input frames');
  let nextTick = 1;
  for (const frame of value.inputs) {
    onlyKeys(frame, ['tick', 'count', 'commands', 'secondaries', 'enemyFire'], 'input');
    if (frame.tick !== nextTick || !integer(frame.count, 1, value.durationTicks) || nextTick + frame.count - 1 > value.durationTicks) invalid('Input ranges must partition all ticks');
    if (!Array.isArray(frame.commands) || frame.commands.length !== 4 || !frame.commands.every((command) => integer(command, 0, 511) && (command & 7) <= 4 && ((command >> 3) & 7) <= 4)) invalid('Invalid packed command');
    if (!Array.isArray(frame.secondaries) || frame.secondaries.length !== 4 || !frame.secondaries.every((secondary) => integer(secondary, 0, 4)) || typeof frame.enemyFire !== 'boolean') invalid('Invalid secondary/enemy input');
    if (value.mode === 'single' && frame.commands.slice(1).some(Boolean)) invalid('Single-player recording contains other player input');
    nextTick += frame.count;
  }
  if (nextTick !== value.durationTicks + 1) invalid('Input recording is incomplete');
  if (!Array.isArray(value.events) || value.events.length > LIMITS.maxEvents) invalid('Invalid replay events');
  let previousTick = 0;
  for (const event of value.events) {
    onlyKeys(event, ['tick', 'kind', 'value', 'slot', 'connected'], 'event');
    if (!integer(event.tick, 1, value.durationTicks) || event.tick < previousTick || !integer(event.slot, 0, 3) || typeof event.connected !== 'boolean') invalid('Invalid event ordering or player slot');
    if (!['magicpickup', 'pickup', 'powerup', 'participant', 'begin', 'tank'].includes(event.kind)) invalid('Invalid event kind');
    if (event.kind === 'tank' && (value.config.tankStatsVersion !== 1 || value.mode === 'single' || typeof event.value !== 'string' || !/^[0-3]$/.test(event.value))) invalid('Invalid tank selection');
    if (event.kind === 'magicpickup') {
      const p = typeof event.value === 'string' ? event.value.split('|') : [];
      if (p.length !== 4 || !POWERS.has(p[0]) || !/^[1-9][0-9]*$/.test(p[1]) || !/^[1-9][0-9]*$/.test(p[2]) ||
          !integer(Number(p[1]),32,value.map.field.widthTiles*64-33) || !integer(Number(p[2]),32,value.map.field.heightTiles*64-33) ||
          Number(p[1])%32 || Number(p[2])%32 || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p[3])) invalid('Invalid MagicBlock drop');
    }
    if (event.kind === 'powerup'  && !POWERS.has(event.value)) invalid('Invalid power-up event');
    if (event.kind === 'pickup' && event.value !== null && !POWERS.has(event.value) && !['batc100', 'batc200'].includes(event.value)) invalid('Invalid pickup event');
    if (['participant', 'begin'].includes(event.kind) && event.value !== null) invalid('Invalid participant/begin value');
    if (value.mode === 'single' && (['participant', 'begin'].includes(event.kind) || event.slot !== 0)) invalid('Invalid single-player event');
    previousTick = event.tick;
  }
  const expectedTicks = [0];
  for (let tick = 60; tick < value.durationTicks; tick += 60) expectedTicks.push(tick);
  expectedTicks.push(value.durationTicks);
  if (!Array.isArray(value.checkpoints) || value.checkpoints.length !== expectedTicks.length) invalid('Missing required state checkpoints');
  value.checkpoints.forEach((checkpoint, index) => {
    onlyKeys(checkpoint, ['tick', 'stateHash'], 'checkpoint');
    if (checkpoint.tick !== expectedTicks[index] || !HASH.test(checkpoint.stateHash)) invalid('Invalid state checkpoint');
  });
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > LIMITS.maxBytes) throw new ReplayError(413, 'Replay exceeds upload size limit');
  return value;
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function payloadHash(value) { return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex'); }
async function readBoundedJson(request, limit = LIMITS.maxBytes) {
  if (Number(request.headers.get('content-length')) > limit) throw new ReplayError(413, 'Request exceeds size limit');
  const reader = request.body?.getReader();
  if (!reader) invalid('JSON body is required');
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new ReplayError(413, 'Request exceeds size limit'); }
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { invalid('Invalid JSON'); }
  } finally { reader.releaseLock(); }
}
module.exports = { FORMAT, LIMITS, ReplayError, validateSessionInput, validateReplay, validateClaim, payloadHash, readBoundedJson };
