/**
 * A small in-memory rate limit for public endpoints that do expensive work (e.g. starting
 * Chromium to print a PDF). It is per server instance, so it isn't exact across Vercel
 * instances, but it stops a script from hammering one token, at no cost (no Redis).
 */
const hits = new Map<string, number[]>();
const MAX_KEYS = 5_000;

export function allowRequest(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > MAX_KEYS) {
    // Forget the oldest keys so the map can't grow without bound.
    for (const k of hits.keys()) {
      hits.delete(k);
      if (hits.size <= MAX_KEYS / 2) break;
    }
  }
  return true;
}

/** Tests only. */
export function resetThrottle() {
  hits.clear();
}
