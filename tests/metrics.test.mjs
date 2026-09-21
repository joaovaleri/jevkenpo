import test from 'node:test';
import assert from 'node:assert/strict';
import { BlobNotFoundError } from '@vercel/blob';
import { createMetricsHandler } from '../lib/metrics.mjs';
import { createRunSigner } from '../lib/cloud-game.mjs';

const id = 'c2b4c6d8-1234-4567-8901-0123456789ab';
const adminKey = 'test-only-private-key';
const signingKey = 'test-only-signing-key';
const request = (event = 'visit', extra = {}) => new Request('https://game.test/api/metrics', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://game.test' },
  body: JSON.stringify({ id, event, ...extra }),
});
const read = key => new Request('https://game.test/api/metrics', { headers: key ? { Authorization: `Bearer ${key}` } : {} });
function fixture() {
  const blobs = new Map();
  const writes = [];
  const options = {
    adminKey, signingKey, enabled: true,
    lookup: async path => { if (!blobs.has(path)) throw new BlobNotFoundError(); return { pathname: path }; },
    write: async (path, content, settings) => { writes.push({ path, content, settings }); blobs.set(path, content); },
    scan: async () => ({ blobs: [...blobs.keys()].map(pathname => ({ pathname })), hasMore: false }),
  };
  return { options, blobs, writes, handler: createMetricsHandler(options) };
}
function token(verdict = 'win') {
  return createRunSigner(signingKey).sign({
    v: 1, history: ['paper', 'scissors'], over: verdict === 'lose',
    last: { verdict, guess: 'scissors' }, revision: 'test', expires: Date.now() + 60000,
  });
}

test('metrics remain private and contain no browser IDs or answers', async () => {
  const { handler, writes } = fixture();
  assert.equal((await handler(request('played', { token: token() }))).status, 200);
  assert.equal((await handler(read())).status, 401);
  assert.equal((await handler(read('wrong-key'))).status, 401);
  const response = await handler(read(adminKey));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const stats = await response.json();
  assert.equal(stats.visitors, 1);
  assert.equal(stats.players, 1);
  assert.ok(writes.every(row => row.settings.access === 'private'));
  assert.ok(writes.every(row => !row.path.includes(id) && !row.content.includes('scissors')));
});

test('retries and fresh function instances do not double-count or rewrite browsers', async () => {
  const { handler, options, writes } = fixture();
  const results = await Promise.all(Array.from({ length: 5 }, () => handler(request())));
  assert.ok(results.every(result => result.ok));
  await handler(request('played', { token: token() }));
  const fresh = createMetricsHandler(options);
  await fresh(request());
  await fresh(request('played', { token: token('lose') }));
  const stats = await (await fresh(read(adminKey))).json();
  assert.equal(stats.visitors, 1);
  assert.equal(stats.players, 1);
  assert.equal(writes.length, 2);
});

test('unjudged, forged and cross-origin events cannot count as players', async () => {
  const { handler, writes } = fixture();
  for (const extra of [{}, { token: 'forged' }, { token: token('invalid') }, { token: token('repeat') }])
    assert.equal((await handler(request('played', extra))).status, 400);
  assert.equal((await handler(request('visit', { id: 'invalid-id' }))).status, 400);
  const crossSite = request();
  crossSite.headers.set('origin', 'https://other.test');
  assert.equal((await handler(crossSite)).status, 403);
  assert.equal(writes.length, 0);
});

test('storage failures are reported instead of acknowledging lost counts or showing fake zeroes', async () => {
  const { options } = fixture();
  const handler = createMetricsHandler({ ...options,
    write: async () => { throw Error('Store suspended'); },
    scan: async () => { throw Error('Store suspended'); },
  });
  assert.equal((await handler(request())).status, 503);
  assert.equal((await handler(read(adminKey))).status, 503);
  const disabled = createMetricsHandler({ ...options, enabled: false });
  assert.equal((await disabled(read(adminKey))).status, 503);
});
