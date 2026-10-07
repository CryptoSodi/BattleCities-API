import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.getuid() !== 0) throw new Error('Run the installer as root.');
const source = '/tmp/battlecities-api-ci-install';
const library = '/usr/local/lib/battlecities-api-deploy';
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`${command} failed; output withheld.`);
  return result.stdout || '';
}
for (const [user, shell] of [['battlecities-api-deploy', '/bin/bash'], ['battlecities-api-build', '/usr/sbin/nologin']]) {
  const existing = spawnSync('getent', ['passwd', user]);
  if (existing.status === 2) run('useradd', ['--system', '--create-home', '--home-dir', `/var/lib/${user}`, '--shell', shell, user]);
  else if (existing.status !== 0) throw new Error('Account lookup failed.');
}
fs.mkdirSync(library, { recursive: true, mode: 0o755 });
for (const file of ['deploy-shared.mjs', 'accept.mjs', 'deploy.mjs', 'extract.py']) {
  fs.copyFileSync(path.join(source, file), path.join(library, file));
  fs.chmodSync(path.join(library, file), 0o644);
  fs.chownSync(path.join(library, file), 0, 0);
  if (file.endsWith('.mjs')) run('/usr/bin/node', ['--check', path.join(library, file)]);
}
const deployHome = '/var/lib/battlecities-api-deploy';
fs.chownSync(deployHome, 0, 0); fs.chmodSync(deployHome, 0o755);
fs.mkdirSync(`${deployHome}/.ssh`, { recursive: true, mode: 0o755 });
fs.chownSync(`${deployHome}/.ssh`, 0, 0); fs.chmodSync(`${deployHome}/.ssh`, 0o755);
const publicKey = fs.readFileSync(path.join(source, 'deploy-key.pub'), 'utf8').trim();
if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$/.test(publicKey)) throw new Error('Invalid deployment public key.');
fs.writeFileSync(`${deployHome}/.ssh/authorized_keys`, `restrict,command="/usr/bin/node ${library}/accept.mjs" ${publicKey}\n`, { mode: 0o644 });
fs.chownSync(`${deployHome}/.ssh/authorized_keys`, 0, 0); fs.chmodSync(`${deployHome}/.ssh/authorized_keys`, 0o644);
fs.mkdirSync(`${deployHome}/incoming`, { recursive: true, mode: 0o700 });
const deployUid = Number(run('id', ['-u', 'battlecities-api-deploy']).trim());
const deployGid = Number(run('id', ['-g', 'battlecities-api-deploy']).trim());
fs.chownSync(`${deployHome}/incoming`, deployUid, deployGid); fs.chmodSync(`${deployHome}/incoming`, 0o700);
const wrapper = '/usr/local/sbin/battlecities-api-deploy';
fs.writeFileSync(wrapper, `#!/bin/sh\nset -eu\nif [ "\${1:-}" = "status" ]; then\n  exec /usr/bin/node ${library}/deploy.mjs "$@"\nfi\nexec /usr/bin/flock -n /run/lock/battlecities-api-deploy.lock /usr/bin/node ${library}/deploy.mjs "$@"\n`, { mode: 0o755 });
fs.chmodSync(wrapper, 0o755); fs.chownSync(wrapper, 0, 0);
const sudoers = '/etc/sudoers.d/battlecities-api-deploy';
fs.writeFileSync(`${sudoers}.new`, `battlecities-api-deploy ALL=(root) NOPASSWD: ${wrapper}\n`, { mode: 0o440 });
fs.chmodSync(`${sudoers}.new`, 0o440);
run('/usr/sbin/visudo', ['--check', '--file', `${sudoers}.new`]);
fs.renameSync(`${sudoers}.new`, sudoers);
run('/usr/sbin/sshd', ['-t']);
console.log('Dedicated API deployment account, build account, restricted SSH key, and deployment controller installed. Production service unchanged.');
