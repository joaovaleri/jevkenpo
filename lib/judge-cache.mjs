import { createHash } from 'node:crypto';

// Cache full game context: a win in one chain may be a repeat in another.
// Only validated successes are retained; failures can always be retried.
export function cacheJudge(judge, { maxEntries = 10000, ttlMs = 86400000, now = Date.now } = {}) {
  const completed = new Map();
  const pending = new Map();
  return async (current, guess, history) => {
    const key = createHash('sha256').update(JSON.stringify([
      current.name, guess, history.map(item => item.name),
    ])).digest('hex');
    const cached = completed.get(key);
    if (cached && cached.expires > now()) {
      completed.delete(key);
      completed.set(key, cached);
      return { ...cached.result };
    }
    completed.delete(key);
    if (pending.has(key)) return { ...await pending.get(key) };
    const work = Promise.resolve().then(() => judge(current, guess, history)).then(result => {
      if (!['win', 'lose', 'repeat', 'invalid'].includes(result?.verdict) || typeof result?.emoji !== 'string')
        throw new Error('Invalid judge result.');
      if (maxEntries > 0) {
        completed.set(key, { result: { ...result }, expires: now() + ttlMs });
        while (completed.size > maxEntries) completed.delete(completed.keys().next().value);
      }
      return result;
    }).finally(() => pending.delete(key));
    pending.set(key, work);
    return { ...await work };
  };
}
