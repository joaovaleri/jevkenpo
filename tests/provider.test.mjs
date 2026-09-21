import test from 'node:test';
import assert from 'node:assert/strict';
import { askJev, jevConfig, JevBudgetError } from '../lib/judge.mjs';

const current = { name: 'paper' };

test('OpenRouter selects only its own key, with no TypeSafe fallback', () => {
  const env = { JEV_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'test-or', TYPESAFE_API_KEY: 'test-ts' };
  assert.deepEqual(jevConfig({}, env), { provider: 'openrouter', key: 'test-or', model: 'jev-latest' });
  delete env.OPENROUTER_API_KEY;
  assert.equal(jevConfig({}, env).key, undefined);
  assert.equal(jevConfig({ provider: 'typesafe' }, env).key, 'test-ts');
  assert.throws(() => jevConfig({ provider: 'constructor' }, env));
});

test('OpenRouter uses System One with jev-latest and preserves win probabilities', async () => {
  let sent;
  const result = await askJev(current, 'black hole', [current], {
    provider: 'openrouter', key: 'test-or-secret',
    fetchImpl: async (url, options) => {
      sent = { url, options };
      return Response.json({ answers: { verdict: { type: 'choice', choice: 'win', probabilities: { win: 0.99 } } } });
    },
  });
  assert.equal(sent.url, 'https://openrouter.ai/api/v1/systemone');
  assert.equal(sent.options.headers.Authorization, 'Bearer test-or-secret');
  const body = JSON.parse(sent.options.body);
  assert.equal(body.model, 'jev-latest');
  assert.equal(body.questions.verdict.type, 'choice');
  assert.equal(result.winProbability, 0.99);
  assert.ok(!sent.options.body.includes('test-or-secret'));
});

test('key and balance exhaustion stop after one call; temporary holds are distinguished', async () => {
  for (const source of ['openrouter_key_limit', 'openrouter_credits', 'openrouter_in_flight_budget', undefined]) {
    let calls = 0;
    await assert.rejects(askJev(current, 'fire', [current], {
      provider: 'openrouter', key: 'test-or-secret',
      fetchImpl: async () => {
        calls++;
        return Response.json({ error: { message: 'private details', metadata: { limit_source: source } } }, { status: 402 });
      },
    }), error => {
      assert.equal(error instanceof JevBudgetError, ['openrouter_key_limit', 'openrouter_credits'].includes(source));
      assert.ok(!error.message.includes('private details'));
      return true;
    });
    assert.equal(calls, 1);
  }
});
