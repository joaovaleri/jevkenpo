import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { askJev, emojiFor, normalize, validateGuess, jevConfig, JevBudgetError } from './judge.mjs';
import { cacheJudge } from './judge-cache.mjs';

const DAY = 86400000;
const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const freshRun = now => ({ v: 1, history: ['paper'], over: false, last: null, revision: randomBytes(12).toString('hex'), expires: now + DAY });

// A signed, compressed save travels with the browser. Any function instance can
// verify it; no database, sticky sessions, or in-memory session affinity required.
export function createRunSigner(secret, now = Date.now) {
  const signingKey = createHmac('sha256', secret).update('jevkenpo.run-signing.v1').digest();
  const mac = payload => createHmac('sha256', signingKey).update(payload).digest();
  return {
    sign(run) {
      const payload = deflateRawSync(Buffer.from(JSON.stringify(run))).toString('base64url');
      return `${payload}.${mac(payload).toString('base64url')}`;
    },
    verify(token) {
      if (typeof token !== 'string' || token.length > 180000) throw Error('Invalid save.');
      const parts = token.split('.');
      if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) throw Error('Invalid save.');
      const actual = Buffer.from(parts[1], 'base64url');
      const expected = mac(parts[0]);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error('Invalid save.');
      const run = JSON.parse(inflateRawSync(Buffer.from(parts[0], 'base64url'), { maxOutputLength: 200000 }).toString());
      if (run.v !== 1 || !Number.isFinite(run.expires) || run.expires <= now()
        || !Array.isArray(run.history) || run.history.length < 1 || run.history.length > 500
        || run.history[0] !== 'paper' || run.history.some(name => typeof name !== 'string' || !name || name.length > 80)
        || typeof run.over !== 'boolean' || typeof run.revision !== 'string') throw Error('Invalid save.');
      return run;
    },
  };
}

async function readBody(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw Error('Expected JSON.');
  if (Number(request.headers.get('content-length')) > 200000) throw Error('Request too large.');
  const reader = request.body?.getReader();
  const chunks = [];
  let length = 0;
  if (reader) while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 200000) { await reader.cancel(); throw Error('Request too large.'); }
    chunks.push(Buffer.from(value));
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('Invalid request.');
  return body;
}

export function createCloudHandler({ key, model, provider, secret, judge, now = Date.now } = {}) {
  const config = jevConfig({ key, model, provider });
  key = config.key;
  secret ??= process.env.SESSION_SECRET || key;
  const available = Boolean((key || judge) && secret);
  const signer = secret ? createRunSigner(secret, now) : null;
  const evaluate = cacheJudge(judge || ((current, guess, history) => askJev(current, guess, history, config)), { now });
  const rates = new Map();
  const inFlight = new Set();
  const json = (status, data, headers = {}) => Response.json(data, { status, headers: { ...HEADERS, ...headers } });
  const snapshot = run => ({
    history: run.history.map(name => ({ name, emoji: emojiFor(name) })),
    score: run.history.length - 1, over: run.over, last: run.last,
    revision: run.revision, available, token: signer?.sign(run) || null,
  });
  return async request => {
    try {
      const url = new URL(request.url);
      const action = url.searchParams.get('action') || url.pathname.split('/').at(-1);
      if (!['game', 'guess', 'new'].includes(action)) return json(404, { error: 'Not found.' });
      if (!['GET', 'POST'].includes(request.method) || (request.method === 'GET' && action !== 'game'))
        return json(405, { error: 'Method not allowed.' });
      const origin = request.headers.get('origin');
      if ((origin && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site')
        return json(403, { error: 'Open the game to play.' });
      // On Vercel this header is set by the trusted edge. This is a per-instance
      // burst guard; a public launch should also enable Vercel Firewall rules.
      const ip = request.headers.get('x-real-ip') || 'local';
      const time = now();
      for (const [id, rate] of rates) if (rate.until <= time) rates.delete(id);
      if (!rates.has(ip) && rates.size >= 10000) return json(503, { error: 'The game is busy. Try again shortly.' });
      const rate = rates.get(ip) || { count: 0, until: time + 60000 };
      rates.set(ip, rate);
      if (++rate.count > 60) return json(429, { error: 'A little too fast. Try again in a minute.' }, { 'Retry-After': '60' });
      let body = {};
      if (request.method === 'POST') {
        try { body = await readBody(request); } catch { return json(400, { error: 'Invalid or oversized request.' }); }
      }
      if (!available) return json(action === 'game' ? 200 : 503, {
        ...snapshot(freshRun(time)), ...(action === 'game' ? {} : { error: 'Jev is not connected yet. Add the API key on the server.' }),
      });
      let run;
      if (body.token) {
        try { run = signer.verify(body.token); }
        catch { return json(401, { error: 'Your saved run expired. Start a new run.', reset: true }); }
      } else if (action === 'game') run = freshRun(time);
      else return json(401, { error: 'Open the game to start a run.', reset: true });
      if (action === 'game') return json(200, snapshot(run));
      if (body.revision !== run.revision) return json(409, { error: 'Your game changed. Refresh to continue.', game: snapshot(run) });
      if (action === 'new') return json(200, snapshot(freshRun(time)));
      if (run.over) return json(409, { error: 'Start a new run to play again.', game: snapshot(run) });
      let guess;
      try { guess = validateGuess(body.guess); } catch (error) { return json(400, { error: error.message }); }
      if (run.history.some(name => normalize(name) === normalize(guess)))
        return json(200, { ...snapshot(run), result: { verdict: 'repeat', guess } });
      if (run.history.length >= 500) return json(409, { error: '500 things! Share this run and start another.' });
      if (inFlight.has(run.revision)) return json(409, { error: 'Jev is still judging your last answer.' });
      inFlight.add(run.revision);
      try {
        const history = run.history.map(name => ({ name, emoji: emojiFor(name) }));
        const current = history.at(-1);
        const result = await evaluate(current, guess, history);
        if (result.verdict === 'win') run.history.push(guess);
        if (result.verdict === 'lose') run.over = true;
        const last = { ...result, guess, against: current.name };
        const next = { ...run, last, revision: randomBytes(12).toString('hex'), expires: now() + DAY };
        return json(200, { ...snapshot(next), result: last });
      } catch (error) {
        if (error instanceof JevBudgetError) return json(402, { error: error.message, code: 'budget_exhausted' });
        return json(502, { error: 'Jev could not judge that right now. Your run is safe. Try again.' });
      } finally { inFlight.delete(run.revision); }
    } catch { return json(500, { error: 'Something went wrong. Please try again.' }); }
  };
}
