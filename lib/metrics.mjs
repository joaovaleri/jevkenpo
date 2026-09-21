import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { put, list, head, BlobNotFoundError } from '@vercel/blob';
import { createRunSigner } from './cloud-game.mjs';
import { jevConfig } from './judge.mjs';

const PREFIX = 'metrics/v1/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = value => createHash('sha256').update(value).digest();

// One private object per anonymous browser and event. Deterministic paths make
// concurrent requests and retries idempotent across serverless instances.
export function createMetricsHandler({
  adminKey = process.env.METRICS_ADMIN_KEY,
  signingKey = process.env.SESSION_SECRET || jevConfig().key,
  enabled = Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN),
  startedAt = process.env.METRICS_STARTED_AT || null,
  write = put, scan = list, lookup = head, now = Date.now,
} = {}) {
  const signer = signingKey ? createRunSigner(signingKey, now) : null;
  const recorded = new Map();
  const pending = new Map();
  const rates = new Map();
  let cached;
  const json = (status, body) => Response.json(body, { status, headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  } });

  async function record(type, id) {
    const hash = createHmac('sha256', adminKey).update(`jevkenpo.metrics.v1:${id.toLowerCase()}`).digest('hex');
    const path = `${PREFIX}${type}/${hash}.json`;
    if ((recorded.get(path) || 0) > now()) return;
    if (pending.has(path)) return pending.get(path);
    const task = (async () => {
      const abortSignal = AbortSignal.timeout(5000);
      try { await lookup(path, { abortSignal }); }
      catch (error) {
        if (!(error instanceof BlobNotFoundError)) throw error;
        await write(path, JSON.stringify({ version: 1, type }), {
          access: 'private', addRandomSuffix: false, allowOverwrite: true,
          contentType: 'application/json', abortSignal,
        });
      }
    })().then(() => {
      if (recorded.size >= 5000) recorded.delete(recorded.keys().next().value);
      recorded.set(path, now() + 86400000);
      cached = null;
    }).finally(() => pending.delete(path));
    pending.set(path, task);
    return task;
  }

  async function stats() {
    if (cached && cached.until > now()) return cached.data;
    let cursor;
    let visitors = 0;
    let players = 0;
    const signal = AbortSignal.timeout(8000);
    do {
      const page = await scan({ prefix: PREFIX, limit: 1000, cursor, abortSignal: signal });
      for (const blob of page.blobs) {
        if (blob.pathname.startsWith(`${PREFIX}visitors/`)) visitors++;
        if (blob.pathname.startsWith(`${PREFIX}players/`)) players++;
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    const data = { visitors, players, startedAt, updatedAt: new Date(now()).toISOString() };
    cached = { data, until: now() + 60000 };
    return data;
  }

  return async request => {
    if (!enabled || !adminKey) return json(503, { error: 'Metrics are not configured.' });
    if (request.method === 'GET') {
      const supplied = request.headers.get('authorization') || '';
      if (!timingSafeEqual(digest(supplied), digest(`Bearer ${adminKey}`)))
        return json(401, { error: 'Chave de acesso inválida.' });
      try { return json(200, await stats()); }
      catch { return json(503, { error: 'Métricas indisponíveis no momento. Tente mais tarde.' }); }
    }
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' });
    const origin = request.headers.get('origin');
    if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site')
      return json(403, { error: 'Open the game first.' });
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      return json(400, { error: 'Expected JSON.' });
    const ip = request.headers.get('x-real-ip') || 'local';
    for (const [key, rate] of rates) if (rate.until <= now()) rates.delete(key);
    if (rates.size >= 5000 && !rates.has(ip)) return json(429, { error: 'Try later.' });
    const rate = rates.get(ip) || { count: 0, until: now() + 60000 };
    rates.set(ip, rate);
    if (++rate.count > 30) return json(429, { error: 'Try later.' });
    let body;
    try {
      const reader = request.body.getReader();
      const chunks = [];
      let length = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 200000) { await reader.cancel(); return json(413, { error: 'Too large.' }); }
        chunks.push(Buffer.from(value));
      }
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch { return json(400, { error: 'Invalid request.' }); }
    if (!body || !UUID.test(body.id) || !['visit', 'played'].includes(body.event))
      return json(400, { error: 'Invalid event.' });
    if (body.event === 'played') {
      try {
        const run = signer?.verify(body.token);
        if (!run || !['win', 'lose'].includes(run.last?.verdict)) throw Error('Not played.');
      } catch { return json(400, { error: 'A judged answer is required.' }); }
    }
    try {
      await record('visitors', body.id);
      if (body.event === 'played') await record('players', body.id);
      return json(200, { recorded: true });
    } catch { return json(503, { error: 'Metrics temporarily unavailable.' }); }
  };
}
