/*
 * What this browser tab knows about scenario revisions on the server: the
 * newest revision it confirmed per scenario, and the scenario writes it has
 * sent. A detail read ahead of time (by the page render or a sidebar
 * prefetch) is only shown when neither says it may be out of date.
 */

const confirmedUpdatedAtByScenarioId = new Map<string, number>();
let writeEpoch = 0;
let writesInFlight = 0;
let lastWriteSettledAt: number | null = null;

function parseRevision(updatedAt: string | null | undefined): number | null {
  if (!updatedAt) return null;
  const timestamp = Date.parse(updatedAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** Remembers that the server holds at least this revision of a scenario. */
export function noteConfirmedScenarioRevision(
  scenarioId: string | null | undefined,
  updatedAt: string | null | undefined
): void {
  const revision = parseRevision(updatedAt);
  if (!scenarioId || revision === null) return;
  const current = confirmedUpdatedAtByScenarioId.get(scenarioId);
  if (current === undefined || revision > current) {
    confirmedUpdatedAtByScenarioId.set(scenarioId, revision);
  }
}

/** True when this tab already confirmed a newer revision of the scenario. */
export function isBehindConfirmedScenarioRevision(
  scenarioId: string,
  updatedAt: string | null | undefined
): boolean {
  const confirmed = confirmedUpdatedAtByScenarioId.get(scenarioId);
  if (confirmed === undefined) return false;
  const revision = parseRevision(updatedAt);
  return revision === null || revision < confirmed;
}

/**
 * Marks a request that writes scenarios. A write can change what another
 * scenario's detail reads (its linked-condition parents, for example), so
 * details read before it settles are not reused.
 */
export function trackScenarioWrite<T>(write: Promise<T>): Promise<T> {
  writeEpoch += 1;
  writesInFlight += 1;
  const settle = () => {
    writesInFlight -= 1;
    writeEpoch += 1;
    lastWriteSettledAt = Date.now();
  };
  return write.then(
    value => {
      settle();
      return value;
    },
    (error: unknown) => {
      settle();
      throw error;
    }
  );
}

/**
 * Identifies the set of scenario writes that have settled so far; null while
 * one is still in flight. A read that starts and ends under the same epoch
 * overlapped no write from this tab.
 */
export function readSettledScenarioWriteEpoch(): number | null {
  return writesInFlight === 0 ? writeEpoch : null;
}

/**
 * True while a scenario write from this tab is in flight, or when one
 * settled at or after `time` (this browser's clock).
 */
export function hasScenarioWriteSince(time: number): boolean {
  return (
    writesInFlight > 0 ||
    (lastWriteSettledAt !== null && lastWriteSettledAt >= time)
  );
}
