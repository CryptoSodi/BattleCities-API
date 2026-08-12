import assert from 'assert/strict';
import fs from 'fs/promises';
import path from 'path';
import test from 'node:test';
import { fileURLToPath } from 'url';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

test('single-player replay session migration stores parent runs and stage links', async () => {
  const sql = await fs.readFile(
    path.join(packageRoot, 'migrations/013_single_player_replay_sessions.sql'),
    'utf8',
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS battlecity_single_player_sessions\b/);
  assert.match(sql, /single_player_session_id/);
  assert.match(sql, /status IN \('active', 'completed'\)/);
});
