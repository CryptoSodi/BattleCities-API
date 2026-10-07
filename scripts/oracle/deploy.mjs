import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { activateRelease, assertMigrationState } from './deploy-shared.mjs';

const base = '/opt/battlecities-api';
const pointer = `${base}/current`;
const service = 'battlecities-api.service';
let cancelled = false;
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { cancelled = true; });
process.stdout.on('error', (error) => { if (error.code !== 'EPIPE') throw error; });
process.stderr.on('error', (error) => { if (error.code !== 'EPIPE') throw error; });
function report(step, details = {}) { console.log(JSON.stringify({ step, ...details })); }
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed; inspect the protected deployment logs on Oracle.`);
  return result.stdout || '';
}
function sql(database, input) {
  return run('/usr/bin/sudo', ['-n', '-u', 'postgres', '/usr/bin/psql', '--no-psqlrc', '--dbname', database, '--tuples-only', '--no-align', '--quiet', '--set=ON_ERROR_STOP=1'], { input: `${input}\n`, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function safeName(value) { if (!/^[a-z][a-z0-9_]{1,62}$/.test(value)) throw new Error('Unexpected database identifier.'); return value; }
function uid(user) { return Number(run('id', ['-u', user]).trim()); }
function gid(user) { return Number(run('id', ['-g', user]).trim()); }
function readEnvironment() {
  const environment = {};
  for (const line of fs.readFileSync('/etc/battlecities/api.env', 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    environment[match[1]] = value;
  }
  return environment;
}
function regularFile(file) { if (!fs.lstatSync(file).isFile()) throw new Error('Release metadata must be a regular file.'); return fs.readFileSync(file); }
function migrationFiles(release) {
  const files = {};
  const directory = path.join(release, 'migrations');
  if (!fs.lstatSync(directory).isDirectory()) throw new Error('Invalid migration directory.');
  for (const name of fs.readdirSync(directory).filter((name) => /^\d+_[a-z0-9_-]+\.sql$/.test(name))) files[name.slice(0, -4)] = crypto.createHash('sha256').update(regularFile(path.join(directory, name))).digest('hex');
  return files;
}
function dump(database, destination) {
  const descriptor = fs.openSync(destination, 'wx', 0o600);
  try { run('/usr/bin/sudo', ['-n', '-u', 'postgres', '/usr/bin/pg_dump', '--format=custom', '--dbname', database], { stdio: ['ignore', descriptor, 'pipe'] }); }
  finally { fs.closeSync(descriptor); }
  if (!run('/usr/bin/pg_restore', ['--list', destination]).includes('battlecity_players')) throw new Error('Database backup is incomplete.');
}
function fingerprints(database) {
  const tables = sql(database, "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'battlecity_%' ORDER BY tablename;").split('\n').filter(Boolean);
  const results = {};
  for (const table of tables) {
    safeName(table);
    results[table] = JSON.parse(sql(database, `SELECT json_build_object('count', count(*), 'fingerprint', md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), ''))) FROM public."${table}" t;`));
  }
  return results;
}
async function child(command, args, options) {
  await new Promise((resolve, reject) => {
    const task = spawn(command, args, { ...options, detached: true });
    const deadline = setTimeout(() => {
      try { process.kill(-task.pid, 'SIGKILL'); } catch { /* The process may already have exited. */ }
      reject(new Error('Release validation exceeded its time limit; production remains unchanged.'));
    }, 10 * 60 * 1000);
    task.once('error', () => { clearTimeout(deadline); reject(new Error('Release validation could not start.')); });
    task.once('exit', (code) => { clearTimeout(deadline); code === 0 ? resolve() : reject(new Error('Release validation failed; inspect the protected validation log on Oracle.')); });
  });
}
async function stopStaging(task) {
  if (task.exitCode !== null || task.signalCode !== null) return;
  await new Promise((resolve) => {
    task.once('exit', resolve);
    task.kill('SIGTERM');
    setTimeout(() => { if (task.exitCode === null && task.signalCode === null) task.kill('SIGKILL'); resolve(); }, 10000).unref();
  });
}
async function ready(baseUrl, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const [health, readiness] = await Promise.all([fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) }), fetch(`${baseUrl}/api/ready`, { signal: AbortSignal.timeout(2000) })]);
      if (health.ok && readiness.ok && (await health.json()).ok && (await readiness.json()).ready) return true;
    } catch { /* Retry while the service starts. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
function checkpoint() { if (cancelled) throw new Error('Deployment cancelled before changing production.'); }

let clone, role, staging, backup, logDescriptor;
try {
  if (process.getuid() !== 0) throw new Error('Deployment must run through the installed root controller.');
  const [action, commit, checksum, upload, ...extra] = process.argv.slice(2);
  if (action === 'status' && !commit) {
    const manifest = JSON.parse(fs.readFileSync(path.join(pointer, 'release.json'), 'utf8'));
    report('status', { commit: manifest.commit, version: manifest.version, service: run('systemctl', ['is-active', service]).trim() });
  } else {
    if (action !== 'deploy' || extra.length || !/^[a-f0-9]{40}$/.test(commit || '') || !/^[a-f0-9]{64}$/.test(checksum || '')) throw new Error('Invalid deployment arguments.');
    const incoming = '/var/lib/battlecities-api-deploy/incoming/';
    if (!upload?.startsWith(incoming) || path.dirname(upload) !== incoming.slice(0, -1) || !new RegExp(`^${commit}-[a-f0-9-]{36}\\.tar$`).test(path.basename(upload))) throw new Error('Invalid upload location.');
    const descriptor = fs.openSync(upload, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let archive;
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.uid !== uid('battlecities-api-deploy') || stat.size > 100 * 1024 * 1024) throw new Error('Invalid release archive.');
      archive = fs.readFileSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    if (crypto.createHash('sha256').update(archive).digest('hex') !== checksum) throw new Error('Release archive checksum failed.');
    const previous = fs.realpathSync(pointer);
    if (path.dirname(previous) !== `${base}/releases`) throw new Error('Unexpected current release.');
    const existing = JSON.parse(fs.readFileSync(path.join(previous, 'release.json'), 'utf8'));
    if (existing.commit === commit) { report('already-deployed', { commit, version: existing.version }); }
    else {
      const available = fs.statfsSync(base);
      if (Number(available.bavail) * Number(available.bsize) < 512 * 1024 * 1024) throw new Error('Insufficient disk space for a backed-up deployment.');
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      backup = `/var/backups/battlecities/auto-${stamp}-${commit.slice(0, 12)}`;
      const release = `${base}/releases/${commit}-${stamp}`;
      fs.mkdirSync(backup, { mode: 0o700 });
      fs.copyFileSync('/etc/battlecities/api.env', path.join(backup, 'api.env'));
      fs.chmodSync(path.join(backup, 'api.env'), 0o600);
      fs.writeFileSync(path.join(backup, 'service.conf'), run('systemctl', ['cat', service]), { mode: 0o600 });
      fs.writeFileSync(path.join(backup, 'source.tar'), archive, { mode: 0o600 });
      fs.mkdirSync(release, { mode: 0o755 });
      const buildUid = uid('battlecities-api-build'), buildGid = gid('battlecities-api-build');
      fs.chownSync(release, buildUid, buildGid);
      const readableArchive = path.join(release, '.upload.tar');
      fs.writeFileSync(readableArchive, archive, { mode: 0o400 });
      fs.chownSync(readableArchive, buildUid, buildGid);
      const basicEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/var/lib/battlecities-api-build', npm_config_cache: '/var/lib/battlecities-api-build/.npm' };
      logDescriptor = fs.openSync(path.join(backup, 'validation.log'), 'a', 0o600);
      const buildOptions = { cwd: release, env: basicEnv, uid: buildUid, gid: buildGid, stdio: ['ignore', logDescriptor, logDescriptor] };
      await child('/usr/bin/python3', ['/usr/local/lib/battlecities-api-deploy/extract.py', readableArchive, release, commit], buildOptions);
      fs.unlinkSync(readableArchive);
      report('source-verified', { commit });
      await child('/usr/bin/npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], buildOptions);
      await child('/usr/bin/npm', ['run', 'build'], buildOptions);
      const packageMetadata = JSON.parse(regularFile(path.join(release, 'package.json')).toString());
      if (packageMetadata.name !== '@battlecities/api-server' || !/^\d+\.\d+\.\d+$/.test(packageMetadata.version)) throw new Error('Unexpected API package.');
      const environment = readEnvironment();
      const databaseUrl = new URL(environment.DATABASE_URL);
      if (databaseUrl.hostname !== '127.0.0.1' || databaseUrl.pathname !== '/battlecities') throw new Error('Unexpected production database.');
      const database = 'battlecities';
      const applied = sql(database, 'SELECT version FROM battlecity_schema_migrations ORDER BY version;').split('\n').filter(Boolean);
      const approvalPath = '/etc/battlecities/api-migration-approvals.json';
      let approvals = {};
      if (fs.existsSync(approvalPath)) {
        const info = fs.lstatSync(approvalPath);
        if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error('Migration approvals must be protected and root-owned.');
        approvals = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
      }
      assertMigrationState(applied, migrationFiles(previous), migrationFiles(release), approvals);
      checkpoint();
      dump(database, path.join(backup, 'preflight.dump'));
      report('backup-created', { backup });
      clone = safeName(`bc_api_check_${commit.slice(0, 12)}_${Date.now()}`);
      role = clone;
      const password = crypto.randomBytes(32).toString('hex');
      sql('postgres', `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${password}';`);
      run('/usr/bin/sudo', ['-n', '-u', 'postgres', '/usr/bin/createdb', '--owner', role, '--template', 'template0', clone]);
      const restoreDescriptor = fs.openSync(path.join(backup, 'preflight.dump'), 'r');
      try { run('/usr/bin/sudo', ['-n', '-u', 'postgres', '/usr/bin/pg_restore', '--exit-on-error', '--no-owner', '--no-privileges', '--role', role, '--dbname', clone], { stdio: [restoreDescriptor, logDescriptor, logDescriptor] }); }
      finally { fs.closeSync(restoreDescriptor); }
      const validationUrl = new URL('postgresql://127.0.0.1:5432');
      validationUrl.username = role; validationUrl.password = password; validationUrl.pathname = `/${clone}`;
      const before = fingerprints(clone);
      const testEnv = { ...basicEnv, NODE_ENV: 'test', BATTLECITY_TEST_DATABASE_URL: validationUrl.toString(), BATTLECITY_DATABASE_SSL: 'disable', BATTLECITY_COMPETITIONS_WORKER_ENABLED: '0', BATTLECITY_LEADERBOARD_REWARDS_ENABLED: '0', BATTLECITY_DROP_REWARDS_ENABLED: '0' };
      await child('/usr/bin/node', ['--test', ...fs.readdirSync(path.join(release, 'tests')).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => `tests/${name}`)], { ...buildOptions, env: testEnv });
      const stageEnv = { ...testEnv, NODE_ENV: 'production', DATABASE_URL: validationUrl.toString(), BATTLECITY_STORAGE_MODE: 'postgres', PORT: '3901', BATTLECITY_API_HOST: '127.0.0.1', BATTLECITY_WEB_BASE_URL: 'https://battlecities.com' };
      staging = spawn('/usr/bin/node', ['dist/src/index.js'], { ...buildOptions, env: stageEnv });
      if (!await ready('http://127.0.0.1:3901')) throw new Error('Staging API did not become ready.');
      if (staging.exitCode !== null || staging.signalCode !== null) throw new Error('Staging process exited; production remains unchanged.');
      if (JSON.stringify(fingerprints(clone)) !== JSON.stringify(before)) throw new Error('Validation changed existing database records; production remains unchanged.');
      await stopStaging(staging);
      staging = null;
      checkpoint();
      run('/usr/bin/chown', ['-R', 'root:root', release]);
      const manifest = { commit, version: packageMetadata.version, archiveSha256: checksum, builtAt: new Date().toISOString(), previousRelease: previous, backup };
      fs.writeFileSync(path.join(release, 'release.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 });
      const rollback = `import fs from 'node:fs';\nimport { execFileSync } from 'node:child_process';\nif (process.getuid() !== 0) throw new Error('Run as root.');\nconst next = ${JSON.stringify(pointer + '.manual-rollback')};\nfs.symlinkSync(${JSON.stringify(previous)}, next);\nfs.renameSync(next, ${JSON.stringify(pointer)});\nexecFileSync('systemctl', ['restart', ${JSON.stringify(service)}]);\nconsole.log('Previous API restored; production database retained.');\n`;
      fs.writeFileSync(path.join(backup, 'rollback.mjs'), rollback, { mode: 0o600 });
      dump(database, path.join(backup, 'before-switch.dump'));
      checkpoint();
      report('validation-passed', { commit, version: packageMetadata.version, unchangedTables: Object.keys(before).length });
      await activateRelease({ pointer, release, restart: () => run('systemctl', ['restart', service]), ready: async () => await ready('http://127.0.0.1:3001') && await ready('https://api.battlecities.com', 6) });
      const result = { ...manifest, deployedAt: new Date().toISOString(), databasePreserved: true, health: true, ready: true };
      fs.writeFileSync(path.join(backup, 'deployment.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
      fs.writeFileSync(`${base}/last-deployment.json`, JSON.stringify(result, null, 2) + '\n', { mode: 0o644 });
      report('deployed', result);
    }
  }
} catch (error) {
  report('failed', { reason: error.message, ...(backup ? { backup } : {}) });
  process.exitCode = 1;
} finally {
  if (staging) await stopStaging(staging);
  if (clone) {
    try { safeName(clone); run('/usr/bin/sudo', ['-n', '-u', 'postgres', '/usr/bin/dropdb', '--if-exists', '--force', clone]); }
    catch { report('cleanup-required', { database: clone }); }
  }
  if (role) {
    try { safeName(role); sql('postgres', `DROP ROLE IF EXISTS "${role}";`); }
    catch { report('cleanup-required', { role }); }
  }
  if (logDescriptor !== undefined) fs.closeSync(logDescriptor);
}
