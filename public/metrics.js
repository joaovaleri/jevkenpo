let id;
const recorded = new Set();
const pending = new Set();
try {
  id = localStorage.getItem('jevkenpo-visitor-v1');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('jevkenpo-visitor-v1', id); }
  for (const event of ['visit', 'played']) {
    if (localStorage.getItem(`jevkenpo-counted-${event}-v1`) === id) recorded.add(event);
  }
} catch { id ||= crypto.randomUUID(); }

export async function recordMetric(event, token) {
  if (recorded.has(event) || pending.has(event)) return;
  pending.add(event);
  try {
    const response = await fetch('/api/metrics', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, event, ...(token ? { token } : {}) }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return;
    const data = await response.json();
    if (!data.recorded) return;
    recorded.add(event);
    try { localStorage.setItem(`jevkenpo-counted-${event}-v1`, id); } catch { /* Count once this visit. */ }
  } catch { /* Analytics must never interrupt the game. */ }
  finally { pending.delete(event); }
}
