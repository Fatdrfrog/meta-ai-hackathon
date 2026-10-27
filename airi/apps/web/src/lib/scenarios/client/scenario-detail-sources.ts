import {
  INITIAL_SCENARIO_DETAIL_MAX_AGE_MS,
  type InitialScenarioDetail,
} from "@/lib/scenarios/initial-scenario-detail";
import type {
  ScenarioDetailApiResponse,
  ScenarioRawGraphEdge,
  ScenarioRawGraphNode,
} from "@icecore/scenario-contracts";
import { fetchScenarioById } from "./crud";
import { readScenarioDetailPayload } from "./http";
import {
  hasScenarioWriteSince,
  isBehindConfirmedScenarioRevision,
  readSettledScenarioWriteEpoch,
} from "./scenario-revision-tracker";

/*
 * Scenario details the canvas may open without asking the server again: the
 * one the page read while it rendered, and ones the sidebar read ahead when
 * the pointer or focus reached a scenario.
 */

export type ScenarioDetail = ScenarioDetailApiResponse<
  ScenarioRawGraphNode,
  ScenarioRawGraphEdge
>;

/** How long a detail read ahead from the sidebar stays usable. */
export const SCENARIO_DETAIL_PREFETCH_MAX_AGE_MS = 15_000;

const claimedInitialDetails = new WeakSet<object>();

function readInitialDetailResponse(
  initial: InitialScenarioDetail,
  scenarioId: string,
  now: number
): ScenarioDetail | null {
  // A browser clock behind the server's gives a negative age: still fresh.
  // The page may have read before a scenario write from this tab landed, so
  // none may be running or have settled within the read's usable age.
  if (
    initial.scenarioId !== scenarioId ||
    now - initial.loadedAt > INITIAL_SCENARIO_DETAIL_MAX_AGE_MS ||
    hasScenarioWriteSince(now - INITIAL_SCENARIO_DETAIL_MAX_AGE_MS)
  ) {
    return null;
  }
  try {
    const detail = readScenarioDetailPayload(initial.response);
    if (
      detail.scenario._id !== scenarioId ||
      isBehindConfirmedScenarioRevision(scenarioId, detail.scenario.updatedAt)
    ) {
      return null;
    }
    return detail;
  } catch {
    return null;
  }
}

/**
 * The page's own read of the scenario it opens, at most once. The App Router
 * replays cached page payloads on back and forward navigation, so a claimed
 * detail (or its promise) is never used again, and one older than this tab's
 * own confirmed revision of the scenario, or than its latest scenario write,
 * is ignored.
 */
export function claimInitialScenarioDetail(
  source: PromiseLike<InitialScenarioDetail | null>,
  initial: InitialScenarioDetail | null,
  { scenarioId, now = Date.now() }: { scenarioId: string; now?: number }
): ScenarioDetail | null {
  if (claimedInitialDetails.has(source)) return null;
  claimedInitialDetails.add(source);
  if (!initial || claimedInitialDetails.has(initial)) return null;
  claimedInitialDetails.add(initial);
  return readInitialDetailResponse(initial, scenarioId, now);
}

/** Gives up the page's read, for example once the editor's own read won. */
export function forgoInitialScenarioDetail(
  source: PromiseLike<InitialScenarioDetail | null>
): void {
  claimedInitialDetails.add(source);
}

type ScenarioDetailPrefetch = {
  startedAt: number;
  writeEpoch: number;
  detail: Promise<ScenarioDetail | null>;
};

const prefetches = new Map<string, ScenarioDetailPrefetch>();

function prefetchKey(workspaceId: string, scenarioId: string) {
  return `${workspaceId}\u0000${scenarioId}`;
}

function isUsablePrefetch(entry: ScenarioDetailPrefetch, now: number) {
  return (
    now - entry.startedAt < SCENARIO_DETAIL_PREFETCH_MAX_AGE_MS &&
    readSettledScenarioWriteEpoch() === entry.writeEpoch
  );
}

function forgetUnusablePrefetches(now: number) {
  for (const [key, entry] of prefetches) {
    if (!isUsablePrefetch(entry, now)) prefetches.delete(key);
  }
}

/**
 * Starts reading a scenario's detail ahead of a likely open. Nothing is read
 * while a scenario write from this tab is in flight, since its outcome can
 * change the detail.
 */
export function prefetchScenarioDetail({
  workspaceId,
  scenarioId,
  now = Date.now(),
}: {
  workspaceId: string;
  scenarioId: string;
  now?: number;
}): void {
  forgetUnusablePrefetches(now);
  const key = prefetchKey(workspaceId, scenarioId);
  const writeEpoch = readSettledScenarioWriteEpoch();
  if (prefetches.has(key) || writeEpoch === null) return;
  prefetches.set(key, {
    startedAt: now,
    writeEpoch,
    detail: fetchScenarioById({
      workspaceId,
      scenarioId,
      mediaSigning: "deferred",
    }).catch(() => null),
  });
}

/**
 * Takes the detail read ahead for this scenario, if one is still usable: at
 * most SCENARIO_DETAIL_PREFETCH_MAX_AGE_MS old, and no scenario write from
 * this tab started since it began or before it answered. The caller still
 * checks the revision against the scenario's list entry.
 */
export async function takePrefetchedScenarioDetail({
  workspaceId,
  scenarioId,
  now = Date.now(),
}: {
  workspaceId: string;
  scenarioId: string;
  now?: number;
}): Promise<ScenarioDetail | null> {
  const key = prefetchKey(workspaceId, scenarioId);
  const entry = prefetches.get(key);
  prefetches.delete(key);
  if (!entry || !isUsablePrefetch(entry, now)) return null;
  const detail = await entry.detail;
  if (
    !detail ||
    detail.scenario._id !== scenarioId ||
    readSettledScenarioWriteEpoch() !== entry.writeEpoch
  ) {
    return null;
  }
  return detail;
}
