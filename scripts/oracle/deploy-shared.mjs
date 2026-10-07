import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function migrationDigest(sql) {
  return crypto.createHash('sha256').update(String(sql).replace(/\r\n/g, '\n')).digest('hex');
}

export function parseRequest(command) {
  if (command === 'status') return { action: 'status' };
  const match = /^deploy ([a-f0-9]{40}) ([a-f0-9]{64})$/.exec(command || '');
  if (!match || match[0] !== command) throw new Error('Only a deployment request or status check is allowed.');
  return { action: 'deploy', commit: match[1], checksum: match[2] };
}

export function assertMigrationState(applied, previousFiles, nextFiles, approved = {}) {
  const versions = [...applied].sort();
  if (JSON.stringify(versions) !== JSON.stringify(Object.keys(nextFiles).sort())) {
    throw new Error('Database migrations require a separate reviewed rollout; production remains unchanged.');
  }
  for (const version of versions) {
    const expected = approved[version] || previousFiles[version];
    if (!expected || expected !== nextFiles[version]) {
      throw new Error('An applied migration was changed; production remains unchanged.');
    }
  }
}

export function swapPointer(pointer, target) {
  const temporary = `${pointer}.switch-${process.pid}`;
  fs.symlinkSync(target, temporary);
  try { fs.renameSync(temporary, pointer); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export async function activateRelease({ pointer, release, restart, ready }) {
  const previous = fs.realpathSync(pointer);
  const parent = fs.realpathSync(path.dirname(previous));
  if (path.dirname(fs.realpathSync(release)) !== parent) throw new Error('Unexpected release location.');
  swapPointer(pointer, release);
  try {
    await restart();
    if (!await ready()) throw new Error('New release failed health checks.');
    return previous;
  } catch (error) {
    swapPointer(pointer, previous);
    try {
      await restart();
      if (!await ready()) throw new Error('Previous release failed readiness.');
    } catch {
      throw new Error('Rollback needs administrator attention; the previous release pointer has been restored.');
    }
    throw new Error(`${error.message} Previous API restored; production database retained.`);
  }
}
