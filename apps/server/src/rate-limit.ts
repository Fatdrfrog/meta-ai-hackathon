// The shop page's chat is public and every message costs a model call, so each sender, chat and
// shop gets a budget per window. In memory: one server process, and a restart only resets it.
export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return {
    /** Records a hit for `key` and says whether it is within the limit. */
    allow(key: string): boolean {
      const cutoff = now() - windowMs;
      const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now());
      hits.set(key, recent);
      return true;
    },
  };
}
