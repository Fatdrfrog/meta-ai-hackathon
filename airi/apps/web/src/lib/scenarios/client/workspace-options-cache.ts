/**
 * How long a workspace's scenario options are shown before any answer, so
 * coming back to the Scenarios page within a few minutes shows them at once.
 */
export const SCENARIO_WORKSPACE_OPTIONS_TTL_MS = 5 * 60_000;

export type WorkspaceOptionsCache<T> = {
  /** The stored value when it is still fresh, otherwise null. */
  read: (workspaceId: string) => T | null;
  /**
   * Asks again (sharing a request that is still running), so options made
   * elsewhere appear; `read` covers the wait.
   */
  load: (workspaceId: string) => Promise<T>;
  /** Drops the stored value, and a running request's answer too. */
  forget: (workspaceId: string) => void;
};

/**
 * Keeps the last successful answer per workspace for this browser tab, shown
 * while the next request runs. A failed request answers its caller but is
 * never stored.
 */
export function createWorkspaceOptionsCache<T>(
  request: (workspaceId: string) => Promise<{ ok: boolean; value: T }>
): WorkspaceOptionsCache<T> {
  const stored = new Map<string, { value: T; storedAt: number }>();
  const pending = new Map<string, Promise<T>>();
  const generations = new Map<string, number>();

  const read = (workspaceId: string) => {
    const entry = stored.get(workspaceId);
    if (!entry) return null;
    if (Date.now() - entry.storedAt < SCENARIO_WORKSPACE_OPTIONS_TTL_MS) {
      return entry.value;
    }
    stored.delete(workspaceId);
    return null;
  };

  const load = (workspaceId: string) => {
    const running = pending.get(workspaceId);
    if (running) return running;
    const generation = generations.get(workspaceId) ?? 0;
    const next = request(workspaceId)
      .then(result => {
        if (result.ok && generations.get(workspaceId) === generation) {
          stored.set(workspaceId, {
            value: result.value,
            storedAt: Date.now(),
          });
        }
        return result.value;
      })
      .finally(() => {
        if (pending.get(workspaceId) === next) pending.delete(workspaceId);
      });
    generations.set(workspaceId, generation);
    pending.set(workspaceId, next);
    return next;
  };

  const forget = (workspaceId: string) => {
    generations.set(workspaceId, (generations.get(workspaceId) ?? 0) + 1);
    stored.delete(workspaceId);
    pending.delete(workspaceId);
  };

  return { read, load, forget };
}
