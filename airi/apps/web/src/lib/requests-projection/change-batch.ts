export function createProjectionChangeBatchReader<T>(
  stream: { tryNext(): Promise<T | null> },
  limit = 64
): { next(): Promise<T[]> } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 256) {
    throw new RangeError(
      "Projection change batch limit must be between 1 and 256"
    );
  }
  // Keep exactly one outstanding cursor read. A getMore that is still waiting
  // for traffic belongs to the next batch; racing it must never discard it.
  let pending: Promise<T | null> | null = null;
  const read = () => (pending ||= stream.tryNext());
  return {
    async next() {
      const first = await read();
      pending = null;
      if (first === null) return [];
      const changes: T[] = [first];
      while (changes.length < limit) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            read().then(value => ({ ready: true as const, value })),
            new Promise<{ ready: false }>(resolve => {
              timer = setTimeout(() => resolve({ ready: false }), 0);
            }),
          ]);
          if (!result.ready) break;
          pending = null;
          if (result.value === null) break;
          changes.push(result.value);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      return changes;
    },
  };
}
