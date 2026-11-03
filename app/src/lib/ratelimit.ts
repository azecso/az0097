// Fixed-window in-memory limiter. Adequate for the single-instance deployment (ADR-002);
// move to PostgreSQL/Redis if the app is ever scaled horizontally.
const hits = new Map<string, { n: number; reset: number }>();
export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const e = hits.get(key);
  if (!e || e.reset <= now) { hits.set(key, { n: 1, reset: now + windowMs }); return true; }
  e.n += 1;
  if (hits.size > 5000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  return e.n <= limit;
}
export function _resetRateLimits() { hits.clear(); }
