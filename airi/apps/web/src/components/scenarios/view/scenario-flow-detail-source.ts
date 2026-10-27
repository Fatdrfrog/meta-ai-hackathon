import { fetchScenarioById } from "@/lib/scenarios/client";
import {
  claimInitialScenarioDetail,
  forgoInitialScenarioDetail,
  takePrefetchedScenarioDetail,
  type ScenarioDetail,
} from "@/lib/scenarios/client/scenario-detail-sources";
import type { InitialScenarioDetail } from "@/lib/scenarios/initial-scenario-detail";
import { scenarioEditorChunks } from "../scenario-editor-chunks";
import type { ScenarioNodeData } from "../types";
import { coldScenarioCanvasChunks } from "./scenario-canvas-editor-chunks";

/**
 * How long the editor waits for the page's own read before asking the
 * server itself (the server's media signing budget). The read streams with
 * the page, so it is normally there already. A later one still wins if it
 * arrives before the editor's own read.
 */
export const INITIAL_SCENARIO_DETAIL_WAIT_MS = 1500;

const LATE = Symbol("late");

type ScenarioFlowDetailRead = {
  workspaceId: string;
  scenarioId: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
};

/** The list entry's revision is not newer than the read's. */
function isAtLeastListRevision(read: string | null, list: string | null) {
  if (!read || !list) return false;
  const readTimestamp = Date.parse(read);
  return Number.isFinite(readTimestamp) && readTimestamp >= Date.parse(list);
}

function fetchFlowDetail(
  { workspaceId, scenarioId }: ScenarioFlowDetailRead,
  signal: AbortSignal
) {
  return fetchScenarioById({
    scenarioId,
    workspaceId,
    signal,
    mediaSigning: "deferred",
  });
}

/** The page's read once it settles, or LATE once the wait is over. */
function waitForInitialDetail(
  read: Promise<InitialScenarioDetail | null>
): Promise<InitialScenarioDetail | null | typeof LATE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof LATE>(resolve => {
    timer = setTimeout(() => resolve(LATE), INITIAL_SCENARIO_DETAIL_WAIT_MS);
  });
  return Promise.race([read, late]).finally(() => clearTimeout(timer));
}

/**
 * Past the wait, the editor asks the server itself, and keeps whichever
 * answers first: the page's read (when still usable) or its own.
 */
async function raceInitialDetail(
  request: ScenarioFlowDetailRead,
  source: PromiseLike<InitialScenarioDetail | null>,
  read: Promise<InitialScenarioDetail | null>
): Promise<ScenarioDetail | null> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  const fetched = fetchFlowDetail(request, controller.signal);
  try {
    const first = await Promise.race([
      read.then(initial => ({ initial })),
      fetched.then(
        () => null,
        () => null
      ),
    ]);
    const claimed =
      first && request.isCurrent()
        ? claimInitialScenarioDetail(source, first.initial, {
            scenarioId: request.scenarioId,
          })
        : null;
    if (claimed || !request.isCurrent()) {
      controller.abort();
      return claimed;
    }
    forgoInitialScenarioDetail(source);
    return await fetched;
  } finally {
    request.signal.removeEventListener("abort", abort);
  }
}

/**
 * The page's read of the opened scenario. Undefined when it is not usable,
 * so the caller reads the scenario itself.
 */
async function readInitialDetail(
  request: ScenarioFlowDetailRead,
  source: PromiseLike<InitialScenarioDetail | null>
): Promise<ScenarioDetail | null | undefined> {
  // The page's promise never rejects; a failure still falls back.
  const read = Promise.resolve(source).then(
    value => value,
    () => null
  );
  const initial = await waitForInitialDetail(read);
  if (!request.isCurrent()) return null;
  if (initial === LATE) return raceInitialDetail(request, source, read);
  return (
    claimInitialScenarioDetail(source, initial, {
      scenarioId: request.scenarioId,
    }) ?? undefined
  );
}

/**
 * The scenario detail the canvas opens: the page's own read on the editor's
 * first load, else one the sidebar read ahead on this visit's first load
 * (only while the scenario's list entry is not newer), else a new read.
 * Resolves null when the load stopped being current while it waited.
 */
export async function readScenarioFlowDetail({
  initialDetail,
  useReadAhead,
  readListUpdatedAt,
  ...request
}: ScenarioFlowDetailRead & {
  initialDetail: PromiseLike<InitialScenarioDetail | null> | null;
  useReadAhead: boolean;
  readListUpdatedAt: () => string | null;
}): Promise<ScenarioDetail | null> {
  if (initialDetail) {
    const fromPage = await readInitialDetail(request, initialDetail);
    if (fromPage !== undefined) return fromPage;
  }
  if (useReadAhead) {
    const prefetched = await takePrefetchedScenarioDetail({
      workspaceId: request.workspaceId,
      scenarioId: request.scenarioId,
    });
    if (!request.isCurrent()) return null;
    if (
      prefetched &&
      isAtLeastListRevision(prefetched.scenario.updatedAt, readListUpdatedAt())
    ) {
      return prefetched;
    }
  }
  return fetchFlowDetail(request, request.signal);
}

/** Starts downloading the editors these steps' canvas cards show. */
export function preloadScenarioFlowEditors(
  nodes: readonly { data: ScenarioNodeData }[]
): void {
  for (const name of coldScenarioCanvasChunks(nodes)) {
    scenarioEditorChunks[name].preload();
  }
}
