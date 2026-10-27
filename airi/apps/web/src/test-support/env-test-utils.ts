/**
 * Deletes the given process.env keys before each test of the enclosing
 * describe block, and after all of them restores the values the keys had
 * when the block was collected. Tests set the values they need themselves.
 */
export function useCleanEnv(keys: readonly string[]) {
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));

  beforeEach(() => {
    for (const key of keys) delete process.env[key];
  });

  afterAll(() => {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}
