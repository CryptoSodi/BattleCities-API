import { rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiServerDirectory = resolve(
  fileURLToPath(new URL('..', import.meta.url)),
);
const outputDirectory = resolve(
  fileURLToPath(new URL('../dist', import.meta.url)),
);

if (
  basename(outputDirectory) !== 'dist' ||
  dirname(outputDirectory) !== apiServerDirectory
) {
  throw new Error(`Refusing to clean unexpected path: ${outputDirectory}`);
}

await rm(outputDirectory, { recursive: true, force: true });
