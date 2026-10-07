import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../src/config/loadLocalEnv').loadLocalEnv();
const store = require('../src/stores/unityReplayStore');
const database = require('../src/database');
const verifier = require('../src/services/unityReplayVerifier');
try {
  const id = process.argv[2];
  if (process.argv.length !== 3 || !store.isReplayId(id)) throw new Error('Usage: node scripts/verify-unity-replay.mjs urp-<ID>');
  const result = await verifier.verifyStoredReplay(id);
  console.log(JSON.stringify(result));
  process.exitCode = result.verification.reproducibilityStatus === 'matched' ? 0 : 1;
} catch (error) {
  console.error(error.message); process.exitCode = 2;
} finally { await database.closePool(); }
