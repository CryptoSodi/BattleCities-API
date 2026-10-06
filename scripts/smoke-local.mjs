import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const serverEntry = fileURLToPath(
  new URL('../dist/api-server/src/index.js', import.meta.url),
);

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'battlecities-smoke-'));
const reservation = net.createServer();
await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const baseUrl = `http://127.0.0.1:${port}`;
const env = { ...process.env, NODE_ENV: 'test', BATTLECITY_STORAGE_MODE: 'local',
  BATTLECITY_API_HOST: '127.0.0.1', PORT: String(port), BATTLECITY_COMPETITIONS_WORKER_ENABLED: '0',
  BATTLECITY_LEADERBOARD_REWARDS_ENABLED: '0', BATTLECITY_DROP_REWARDS_ENABLED: '0',
  BATTLECITY_COMPETITIONS_FILE: path.join(temporaryRoot, 'competitions.json'),
};
for (const dir of ['PLAYER', 'SESSION', 'ECONOMY', 'LEDGER', 'MATCH', 'WALLET_CHALLENGE', 'SEASON', 'TRADING']) {
  env[`BATTLECITY_${dir}_DIR`] = path.join(temporaryRoot, dir);
}
const server = spawn(process.execPath, [serverEntry], {
  cwd: repositoryRoot,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

server.stdout.on('data', (chunk) => process.stdout.write(chunk));
server.stderr.on('data', (chunk) => process.stderr.write(chunk));

try {
  await waitForHealth(server);
  process.env.BATTLECITY_API_SMOKE_URL = baseUrl;
  await import('./smoke.mjs');
} finally {
  if (server.exitCode === null) {
    const stopped = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await stopped;
  }
  const resolved = path.resolve(temporaryRoot);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('battlecities-smoke-')) {
    throw new Error('Refusing to clean an unexpected smoke directory');
  }
  await fs.rm(resolved, { recursive: true, force: true });
}

async function waitForHealth(child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`API exited before smoke test with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // The listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the local API');
}
