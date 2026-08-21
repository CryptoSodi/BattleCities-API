import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const twitterApi = require('../src/services/twitterApiIo.js');

test('TwitterAPI checks a linked account follow relationship with one targeted request', async () => {
  await withKey(async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), options });
      return Response.json({ status: 'success', data: { following: true } });
    };
    try {
      assert.equal(await twitterApi.checkFollowRelationship('@BattlePlayer'), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.match(requests[0].url, /\/twitter\/user\/check_follow_relationship/);
    assert.match(requests[0].url, /source_user_name=BattlePlayer/);
    assert.match(requests[0].url, /target_user_name=BattleCitiesHQ/);
    assert.equal(requests[0].options.headers['x-api-key'], 'test-twitterapi-key');
  });
});

test('TwitterAPI verifies a repost from the task post retweeter list', async () => {
  await withKey(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ users: [{ id: '123456789' }] });
    try {
      assert.equal(await twitterApi.hasReposted('987654321', '123456789'), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

async function withKey(operation) {
  const original = process.env.TWITTERAPI_IO_KEY;
  process.env.TWITTERAPI_IO_KEY = 'test-twitterapi-key';
  try {
    await operation();
  } finally {
    if (original === undefined) delete process.env.TWITTERAPI_IO_KEY;
    else process.env.TWITTERAPI_IO_KEY = original;
  }
}
