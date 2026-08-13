import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('CORS allows the CryptoSodi GitHub Pages testing origin', async () => {
  const source = await fs.readFile(
    path.join(packageRoot, 'src/middleware/cors.ts'),
    'utf8',
  );
  assert.match(source, /cryptosodi\.github\.io/);
});
