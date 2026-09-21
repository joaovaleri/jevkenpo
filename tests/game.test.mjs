import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameServer } from '../server.mjs';
import { makeRequest, parseAnswer, validateGuess, normalize, askJev, emojiFor, JevBudgetError } from '../lib/judge.mjs';
import { cacheJudge } from '../lib/judge-cache.mjs';

async function fixture(t, options = {}) {
  const server = createGameServer({ key: '', ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  let revision;
  async function request(path, body, extraHeaders = {}) {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify({ revision, ...body }) }),
    });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const data = await response.json();
    if (data.revision) revision = data.revision;
    return { status: response.status, data, headers: response.headers };
  }
  return { request, origin };
}

test('real request contract and strict structured-answer validation', () => {
  const request = makeRequest({ name: 'paper' }, 'black hole', [{ name: 'paper' }]);
  assert.equal(request.questions.verdict.type, 'choice');
  assert.equal(request.state.challenger, 'black hole');
  assert.deepEqual(Object.keys(request.questions), ['verdict']);
  assert.deepEqual(parseAnswer({ answers: { verdict: { type: 'choice', choice: 'win' } } }, 'black hole'), { verdict: 'win', emoji: '🕳️' });
  assert.throws(() => parseAnswer({ answers: { verdict: { type: 'choice', choice: 'perhaps' } } }, 'fire'));
  assert.throws(() => parseAnswer({ answers: { verdict: { type: 'noul', noul: 1 } } }, 'fire'));
});

test('emoji selection works locally in both languages, with an honest fallback', () => {
  assert.equal(emojiFor('a black hole'), '🕳️');
  assert.equal(emojiFor('BURACO NEGRO'), '🕳️');
  assert.equal(emojiFor('Hawking radiation'), '⚛️');
  assert.equal(emojiFor('água'), '💧');
  assert.equal(emojiFor('a fire-breathing dragon'), '🐉');
  assert.equal(emojiFor('education'), '📚');
  assert.equal(emojiFor('🧙‍♂️'), '🧙‍♂️');
  assert.equal(emojiFor('a completely new unnamed phenomenon'), '✨');
});

test('win probability comes from the win option even on losses, never from confidence', () => {
  for (const win of [0, 0.27, 1]) {
    const result = parseAnswer({ answers: { verdict: {
      type: 'choice', choice: win === 1 ? 'win' : 'lose', confidence: 0.99,
      probabilities: { win, lose: 1 - win, repeat: 0, invalid: 0 },
    } } }, 'rock');
    assert.equal(result.winProbability, win);
  }
  for (const win of [undefined, null, '0.7', -0.1, 1.1, NaN, Infinity]) {
    const result = parseAnswer({ answers: { verdict: {
      type: 'choice', choice: 'win', confidence: 1, probabilities: { win },
    } } }, 'fire');
    assert.equal('winProbability' in result, false);
    assert.equal(result.verdict, 'win');
  }
});

test('cache reuses judgments but keeps chain-dependent repeat checks separate', async () => {
  let calls = 0;
  const judge = cacheJudge(async (_, guess, history) => {
    calls++;
    return { verdict: history.some(item => item.name === guess) ? 'repeat' : 'win', emoji: '🔥', winProbability: 0.73 };
  });
  const current = { name: 'paper' };
  const history = [current];
  const [one, two] = await Promise.all([judge(current, 'fire', history), judge(current, 'fire', history)]);
  assert.equal(calls, 1);
  one.verdict = 'lose';
  assert.equal(two.verdict, 'win');
  assert.equal(two.winProbability, 0.73);
  assert.equal((await judge(current, 'fire', history)).winProbability, 0.73);
  assert.equal((await judge(current, 'fire', history)).verdict, 'win');
  assert.equal(calls, 1);
  assert.equal((await judge(current, 'fire', [{ name: 'fire' }, current])).verdict, 'repeat');
  assert.equal(calls, 2);
});

test('cache expires, bounds memory, and never retains errors or malformed results', async () => {
  let clock = 0;
  let calls = 0;
  let outcome = 'win';
  const judge = cacheJudge(async () => {
    calls++;
    if (outcome === 'throw') throw Error('offline');
    return { verdict: outcome, emoji: '🔥' };
  }, { now: () => clock, ttlMs: 10, maxEntries: 1 });
  const current = { name: 'paper' };
  const ask = guess => judge(current, guess, [current]);
  await ask('fire');
  await ask('fire');
  assert.equal(calls, 1);
  clock = 11;
  await ask('fire');
  assert.equal(calls, 2);
  await ask('water');
  await ask('fire');
  assert.equal(calls, 4);
  outcome = 'throw';
  await assert.rejects(ask('new'));
  outcome = 'unknown';
  await assert.rejects(ask('new'));
  outcome = 'win';
  assert.equal((await ask('new')).verdict, 'win');
  assert.equal(calls, 7);
});

test('names accept Unicode, normalize repeats, and reject invalid lengths', () => {
  assert.equal(validateGuess('  buraco   negro  '), 'buraco negro');
  assert.equal(validateGuess('🧙‍♂️'), '🧙‍♂️');
  assert.equal(normalize(' The PAPER!!! '), normalize('paper'));
  for (const bad of ['', null, 42, 'x'.repeat(81), '\u0000']) assert.throws(() => validateGuess(bad));
});

test('a winning guess becomes the next target; losing ends the run; restart preserves isolation', async t => {
  const seen = [];
  const { request } = await fixture(t, { judge: async (current, guess) => {
    seen.push(current.name);
    return { verdict: guess === 'black hole' ? 'win' : 'lose', emoji: '🕳️' };
  } });
  const start = await request('/api/game');
  assert.equal(start.data.score, 0);
  assert.match(start.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const win = await request('/api/guess', { guess: 'black hole', current: 'banana', score: 999 });
  assert.equal(win.data.score, 1);
  assert.equal(win.data.history.at(-1).name, 'black hole');
  const loss = await request('/api/guess', { guess: 'scissors' });
  assert.equal(loss.data.over, true);
  assert.equal(loss.data.score, 1);
  assert.deepEqual(seen, ['paper', 'black hole']);
  assert.equal((await request('/api/guess', { guess: 'time' })).status, 409);
  const reset = await request('/api/new', {});
  assert.equal(reset.data.history.at(-1).name, 'paper');
  assert.equal(reset.data.over, false);
  assert.equal(reset.data.score, 0);
});

test('literal and semantic repeats do not end the run or add points', async t => {
  let calls = 0;
  const { request } = await fixture(t, { judge: async () => { calls++; return { verdict: 'repeat', emoji: '📄' }; } });
  await request('/api/game');
  const literal = await request('/api/guess', { guess: 'THE PAPER!' });
  assert.equal(literal.data.result.verdict, 'repeat');
  assert.equal(calls, 0);
  const semantic = await request('/api/guess', { guess: 'a sheet of paper' });
  assert.equal(semantic.data.result.verdict, 'repeat');
  assert.equal(semantic.data.score, 0);
  assert.equal(semantic.data.over, false);
  assert.equal(calls, 1);
});

test('parallel submissions cannot skip targets; stale revisions cannot replay moves', async t => {
  let release;
  let started;
  const judging = new Promise(resolve => { started = resolve; });
  const { request } = await fixture(t, { judge: () => { started(); return new Promise(resolve => { release = resolve; }); } });
  const start = await request('/api/game');
  const pending = request('/api/guess', { guess: 'fire' });
  await judging;
  assert.equal((await request('/api/guess', { guess: 'water' })).status, 409);
  assert.equal((await request('/api/new', {})).status, 409);
  release({ verdict: 'win', emoji: '🔥' });
  assert.equal((await pending).data.score, 1);
  const replay = await request('/api/guess', { guess: 'water', revision: start.data.revision });
  assert.equal(replay.status, 409);
  assert.equal(replay.data.game.score, 1);
});

test('upstream failures preserve the run and do not leak server details', async t => {
  let fail = true;
  const { request } = await fixture(t, { judge: async () => {
    if (fail) throw new Error('upstream-secret-detail');
    return { verdict: 'win', emoji: '🔥' };
  } });
  const start = await request('/api/game');
  const error = await request('/api/guess', { guess: 'fire' });
  assert.equal(error.status, 502);
  assert.ok(!JSON.stringify(error.data).includes('upstream-secret-detail'));
  const intact = await request('/api/game');
  assert.equal(intact.data.revision, start.data.revision);
  assert.equal(intact.data.score, 0);
  fail = false;
  assert.equal((await request('/api/guess', { guess: 'fire' })).data.score, 1);
});

test('missing credentials are explicit; cross-origin and oversized input are rejected', async t => {
  const { request, origin } = await fixture(t);
  assert.equal((await request('/api/game')).data.available, false);
  assert.equal((await request('/api/guess', { guess: 'fire' })).status, 503);
  assert.equal((await request('/api/new', {}, { origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await request('/api/new', { padding: 'x'.repeat(3000) })).status, 413);
  const page = await fetch(origin);
  assert.ok(page.headers.get('content-security-policy').includes("script-src 'self'"));
  assert.equal((await fetch(origin + '/.env.local')).status, 404);
});

test('upstream authentication is only sent to TypeSafe, and malformed responses fail closed', async () => {
  let sent;
  await assert.rejects(askJev({ name: 'paper' }, 'fire', [], {
    key: 'test-server-key',
    fetchImpl: async (url, options) => { sent = { url, options }; return new Response(JSON.stringify({ answers: {} }), { status: 200 }); },
  }));
  assert.equal(sent.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(sent.options.headers.Authorization, 'Bearer test-server-key');
  assert.ok(!sent.options.body.includes('test-server-key'));
});

test('local budget exhaustion is explicit and preserves the run', async t => {
  const { request } = await fixture(t, { judge: async () => { throw new JevBudgetError(); } });
  const start = await request('/api/game');
  const failed = await request('/api/guess', { guess: 'fire' });
  assert.equal(failed.status, 402);
  assert.equal(failed.data.code, 'budget_exhausted');
  assert.match(failed.data.error, /spending limit/);
  const intact = await request('/api/game');
  assert.equal(intact.data.revision, start.data.revision);
  assert.equal(intact.data.score, 0);
});
