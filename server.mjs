import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { askJev, normalize, validateGuess } from './lib/judge.mjs';
import { cacheJudge } from './lib/judge-cache.mjs';

const PUBLIC = new URL('./public/', import.meta.url);
const FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);
const DAY = 86400000;
const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const initialRun = () => ({ history: [{ name: 'paper', emoji: '📄' }], over: false, busy: false, last: null, revision: randomBytes(12).toString('hex') });

export function createGameServer({ key = process.env.TYPESAFE_API_KEY, model = process.env.JEV_MODEL || 'jev-1.13.0', judge, now = Date.now } = {}) {
  const sessions = new Map();
  const limits = new Map();
  const evaluate = cacheJudge(judge || ((current, guess, history) => askJev(current, guess, history, { key, model })), { now });
  const available = Boolean(key || judge);
  const snapshot = session => ({
    history: session.run.history, score: session.run.history.length - 1,
    over: session.run.over, last: session.run.last, revision: session.run.revision, available,
  });
  return http.createServer(async (req, res) => {
    const send = (status, data, extra = {}) => {
      res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extra });
      res.end(JSON.stringify(data));
    };
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && FILES.has(path)) {
        const [filename, type] = FILES.get(path);
        const content = await readFile(new URL(filename, PUBLIC));
        res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': type });
        return res.end(content);
      }
      if (!['/api/game', '/api/guess', '/api/new'].includes(path)) return send(404, { error: 'Not found.' });
      if (!((path === '/api/game' && req.method === 'GET') || (path !== '/api/game' && req.method === 'POST')))
        return send(405, { error: 'Method not allowed.' });
      const origin = req.headers.origin;
      const isCrossSite = req.headers['sec-fetch-site'] === 'cross-site';
      let wrongOrigin = false;
      if (origin) {
        try { wrongOrigin = new URL(origin).host !== req.headers.host; } catch { wrongOrigin = true; }
      }
      if (wrongOrigin || isCrossSite) return send(403, { error: 'Open the game to play.' });
      const time = now();
      for (const [id, item] of sessions) if (item.expires < time && !item.run.busy) sessions.delete(id);
      for (const [id, item] of limits) if (item.until < time) limits.delete(id);
      const ip = req.socket.remoteAddress || 'local';
      const bucket = limits.get(ip) || { count: 0, until: time + 60000 };
      // Includes new-session requests so resetting cookies cannot reset the allowance.
      if (++bucket.count > 60) return send(429, { error: 'A little too fast. Try again in a minute.' }, { 'Retry-After': '60' });
      limits.set(ip, bucket);
      const cookie = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('jevkenpo='))?.slice(9);
      let session = cookie && sessions.get(cookie);
      if (!session) {
        if (sessions.size >= 2000) return send(503, { error: 'The game is full right now. Try again shortly.' });
        const id = randomBytes(24).toString('hex');
        session = { run: initialRun(), expires: time + DAY };
        sessions.set(id, session);
        res.setHeader('Set-Cookie', `jevkenpo=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${origin?.startsWith('https:') ? '; Secure' : ''}`);
      }
      session.expires = time + DAY;
      if (path === '/api/game') return send(200, snapshot(session));
      if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'Expected JSON.' });
      let length = 0;
      const chunks = [];
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 2048) return send(413, { error: 'That answer is too long.' });
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return send(400, { error: 'Invalid request.' }); }
      if (!body || typeof body !== 'object') return send(400, { error: 'Invalid request.' });
      if (session.run.busy) return send(409, { error: 'Jev is still judging your last answer.' });
      if (body.revision !== session.run.revision) return send(409, { error: 'Your game changed in another tab. Refresh to continue.', game: snapshot(session) });
      if (path === '/api/new') {
        session.run = initialRun();
        return send(200, snapshot(session));
      }
      if (!available) return send(503, { error: 'Jev is not connected yet. Add TYPESAFE_API_KEY on the server to play.' });
      if (session.run.over) return send(409, { error: 'Start a new run to play again.', game: snapshot(session) });
      let guess;
      try { guess = validateGuess(body.guess); } catch (error) { return send(400, { error: error.message }); }
      if (session.run.history.some(item => normalize(item.name) === normalize(guess)))
        return send(200, { ...snapshot(session), result: { verdict: 'repeat', guess } });
      // Keep full history for the score; constrain context and memory without silently dropping repeats.
      if (session.run.history.length >= 500) return send(409, { error: '500 things! You finished this run. Share it and start another.' });
      session.run.busy = true;
      try {
        const current = session.run.history.at(-1);
        const result = await evaluate(current, guess, session.run.history);
        if (!['win', 'lose', 'repeat', 'invalid'].includes(result.verdict) || typeof result.emoji !== 'string')
          throw new Error('Jev sent an incomplete result. Try again.');
        if (result.verdict === 'win') session.run.history.push({ name: guess, emoji: result.emoji });
        if (result.verdict === 'lose') session.run.over = true;
        session.run.last = { ...result, guess, against: current.name };
        session.run.revision = randomBytes(12).toString('hex');
        return send(200, { ...snapshot(session), result: session.run.last });
      } catch (error) {
        const message = error?.name === 'TimeoutError' ? 'Jev took too long. Your run is safe. Try again.' : 'Jev could not judge that right now. Your run is safe. Try again.';
        return send(502, { error: message });
      } finally { session.run.busy = false; }
    } catch {
      if (!res.headersSent) send(500, { error: 'Something went wrong. Please try again.' });
      else res.end();
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 5180);
  const host = process.env.HOST || '127.0.0.1';
  createGameServer().listen(port, host, () => {
    console.log(`Jevkenpo is ready at http://${host}:${port}`);
    console.log(`Jev: ${process.env.TYPESAFE_API_KEY ? 'connected' : 'missing TYPESAFE_API_KEY'}`);
  });
}
