import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseRequest } from './deploy-shared.mjs';

let upload;
try {
  const request = parseRequest(process.env.SSH_ORIGINAL_COMMAND);
  const args = [request.action];
  if (request.action === 'deploy') {
    upload = `/var/lib/battlecities-api-deploy/incoming/${request.commit}-${crypto.randomUUID()}.tar`;
    const descriptor = fs.openSync(upload, 'wx', 0o600);
    const checksum = crypto.createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of process.stdin) {
        bytes += chunk.length;
        if (bytes > 100 * 1024 * 1024) throw new Error('Release archive exceeds the upload limit.');
        checksum.update(chunk);
        fs.writeSync(descriptor, chunk);
      }
    } finally { fs.closeSync(descriptor); }
    if (bytes === 0 || checksum.digest('hex') !== request.checksum) throw new Error('Release archive checksum failed.');
    args.push(request.commit, request.checksum, upload);
  }
  const code = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sudo', ['-n', '/usr/local/sbin/battlecities-api-deploy', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', reject);
    child.once('exit', resolve);
  });
  process.exitCode = code ?? 1;
} catch (error) { console.error(error.message); process.exitCode = 64; }
finally { if (upload && fs.existsSync(upload)) fs.unlinkSync(upload); }
