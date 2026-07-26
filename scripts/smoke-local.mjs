import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const serverEntry = fileURLToPath(
  new URL('../dist/api-server/src/index.js', import.meta.url),
);

const server = spawn(process.execPath, [serverEntry], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    BATTLECITY_STORAGE_MODE: 'local',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

server.stdout.on('data', (chunk) => process.stdout.write(chunk));
server.stderr.on('data', (chunk) => process.stderr.write(chunk));

try {
  await waitForHealth(server);
  await import('./smoke.mjs');
} finally {
  if (server.exitCode === null) {
    server.kill();
  }
}

async function waitForHealth(child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`API exited before smoke test with code ${child.exitCode}`);
    }
    try {
      const response = await fetch('http://127.0.0.1:3001/api/health');
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
