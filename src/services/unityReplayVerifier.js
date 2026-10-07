const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const store = require('../stores/unityReplayStore');
const { ReplayError } = require('./unityReplayFormat');

// Configured by the server operator only, never from an HTTP request or replay.
async function verifyStoredReplay(id) {
  const record = await store.readReplayAdmin(id);
  if (!record) throw new ReplayError(404, 'Replay not found');
  const verifierPath = process.env.BATTLECITY_UNITY_REPLAY_VERIFIER;
  if (!verifierPath || !path.isAbsolute(verifierPath) || path.extname(verifierPath).toLowerCase() !== '.dll') {
    throw new Error('Configure an absolute trusted BATTLECITY_UNITY_REPLAY_VERIFIER DLL path');
  }
  if (!(await fs.stat(verifierPath)).isFile()) throw new Error('Trusted verifier is not a file');
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'battlecities-verify-'));
  if (path.dirname(path.resolve(directory)) !== temporaryRoot || !path.basename(directory).startsWith('battlecities-verify-')) throw new Error('Invalid verifier temporary path');
  await fs.chmod(directory, 0o700);
  const inputFile = path.join(directory, 'replay.json');
  try {
    await fs.writeFile(inputFile, JSON.stringify(record.replay), { mode: 0o600 });
    const report = await runVerifier(verifierPath, inputFile);
    let evidence;
    if (report.reproduced === true && report.simulationVersion === record.replay.simulationVersion) {
      evidence = { status: 'matched', result: report.result };
    } else if (report.reproduced === false && report.simulationVersion === record.replay.simulationVersion && report.result) {
      evidence = { status: 'diverged', reason: report.error || 'Simulation diverged' };
    } else {
      evidence = { status: 'error', reason: report.error || 'Verifier output/version was unsupported' };
    }
    return store.recordReproduction(id, { ...evidence, payloadHash: record.payloadHash, simulationVersion: record.replay.simulationVersion });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
function runVerifier(verifierPath, inputFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.BATTLECITY_DOTNET_BINARY || 'dotnet', [verifierPath, inputFile],
      { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let bytes = 0; let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Replay verifier exceeded 30 seconds')); }, 30000);
    child.on('error', (error) => finish(error));
    const count = (chunk) => {
      bytes += chunk.length;
      if (bytes > 65536) { child.kill(); finish(new Error('Replay verifier output exceeded limit')); return false; }
      return !settled;
    };
    child.stdout.on('data', (chunk) => { if (count(chunk)) chunks.push(chunk); });
    child.stderr.on('data', count);
    child.on('close', (code) => {
      try {
        const output = JSON.parse(Buffer.concat(chunks).toString('utf8').trim());
        if (!output || typeof output.reproduced !== 'boolean') throw new Error('Invalid replay verifier report');
        if (output.reproduced === true && code !== 0) throw new Error('Replay verifier reported success with a failing exit code');
        finish(null, output);
      } catch (error) { finish(error); }
    });
  });
}
module.exports = { verifyStoredReplay };
