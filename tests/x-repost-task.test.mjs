import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const repostTasks = require('../src/stores/xRepostTaskStore.js');

test('X repost tasks use the post ID in the status path, not URL tracking parameters', () => {
  assert.deepEqual(
    repostTasks.parsePost('https://x.com/BattleCitiesHQ/status/2077486321669693766?s=20'),
    {
      id: '2077486321669693766',
      url: 'https://x.com/BattleCitiesHQ/status/2077486321669693766',
    },
  );
});

test('X repost tasks reject posts that do not belong to Battle Cities', () => {
  assert.throws(
    () => repostTasks.parsePost('https://x.com/someoneelse/status/2077486321669693766'),
    /BattleCitiesHQ/,
  );
});
