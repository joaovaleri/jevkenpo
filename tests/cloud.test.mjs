import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudHandler, createRunSigner } from '../lib/cloud-game.mjs';

const secret = 'test-only-signing-key-never-a-production-credential';
function client(handler) {
  let save;
  return async (action, body, options = {}) => {
    const data = body === undefined ? undefined : { token: save?.token, revision: save?.revision, ...body };
    const request = new Request(`https://game.example/api/${action}`, {
      method: data ? 'POST' : 'GET',
      headers: { origin: 'https://game.example', 'x-real-ip': '192.0.2.1', ...(data ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    const response = await handler(request);
    const result = await response.json();
    if (result.token) save = result;
    return { status: response.status, data: result };
  };
}
const win = async () => ({ verdict: 'win', emoji: '🔥', winProbability: 0.91 });

test('a signed run survives independent Vercel instances and cannot be forged', async () => {
  const a = client(createCloudHandler({ secret, judge: win }));
  await a('game');
  const played = await a('guess', { guess: 'fire' });
  assert.equal(played.data.score, 1);
  assert.equal(played.data.result.winProbability, 0.91);
  const b = client(createCloudHandler({ secret, judge: win }));
  const resumed = await b('game', { token: played.data.token });
  assert.equal(resumed.data.history.at(-1).name, 'fire');
  assert.equal(resumed.data.score, 1);
  assert.equal(resumed.data.last.winProbability, 0.91);
  const next = await b('guess', { guess: 'water' });
  assert.equal(next.data.score, 2);
  const broken = played.data.token.slice(0, -4) + 'AAAA';
  assert.equal((await b('game', { token: broken })).status, 401);
  const wrongKey = client(createCloudHandler({ secret: 'another-secret', judge: win }));
  assert.equal((await wrongKey('game', { token: played.data.token })).status, 401);
});

test('signature rejects altered payloads and expired saves before judging', () => {
  let time = 0;
  const signer = createRunSigner(secret, () => time);
  const run = { v: 1, history: ['paper'], over: false, revision: '1', expires: 100 };
  const token = signer.sign(run);
  assert.deepEqual(signer.verify(token), run);
  assert.throws(() => signer.verify('A' + token));
  time = 100;
  assert.throws(() => signer.verify(token));
});

test('cloud repeats, losses and restart preserve normal game rules', async () => {
  let calls = 0;
  const play = client(createCloudHandler({ secret, judge: async () => { calls++; return { verdict: 'lose', emoji: '🪨' }; } }));
  await play('game');
  assert.equal((await play('guess', { guess: 'THE PAPER!' })).data.result.verdict, 'repeat');
  assert.equal(calls, 0);
  const loss = await play('guess', { guess: 'rock', score: 99 });
  assert.equal(loss.data.score, 0);
  assert.equal(loss.data.over, true);
  assert.equal((await play('guess', { guess: 'fire' })).status, 409);
  assert.equal((await play('new', {})).data.over, false);
});

test('cloud failure leaves the signed run usable and deduplicates shared matches', async () => {
  let calls = 0;
  let fail = true;
  const handler = createCloudHandler({ secret, judge: async () => {
    calls++;
    if (fail) throw Error('private upstream details');
    return { verdict: 'win', emoji: '🔥' };
  } });
  const a = client(handler);
  const start = await a('game');
  const failed = await a('guess', { guess: 'fire' });
  assert.equal(failed.status, 502);
  assert.ok(!JSON.stringify(failed).includes('private upstream details'));
  const restored = await a('game', {});
  assert.equal(restored.data.revision, start.data.revision);
  fail = false;
  assert.equal((await a('guess', { guess: 'fire' })).data.score, 1);
  const b = client(handler);
  await b('game');
  assert.equal((await b('guess', { guess: 'fire' })).data.score, 1);
  assert.equal(calls, 2);
});

test('cloud rejects cross-site requests and oversized input; missing setup is explicit', async () => {
  const play = client(createCloudHandler({ secret, judge: win }));
  await play('game');
  assert.equal((await play('guess', { guess: 'fire' }, { headers: { origin: 'https://elsewhere.example' } })).status, 403);
  assert.equal((await play('guess', { guess: 'x'.repeat(81) })).status, 400);
  assert.equal((await play('guess', { guess: 'fire', padding: 'x'.repeat(200001) })).status, 400);
  const missing = client(createCloudHandler({ key: '', secret: '' }));
  assert.equal((await missing('game')).data.available, false);
  assert.equal((await missing('guess', { guess: 'fire' })).status, 503);
});

test('cloud burst limit is per client within an instance', async () => {
  const play = client(createCloudHandler({ secret, judge: win }));
  for (let i = 0; i < 60; i++) assert.equal((await play('game')).status, 200);
  assert.equal((await play('game')).status, 429);
  assert.equal((await play('game', undefined, { headers: { 'x-real-ip': '192.0.2.2' } })).status, 200);
});
