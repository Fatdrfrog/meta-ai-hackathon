import "server-only";

import { logger } from "@/lib/logger";
import { pickActiveScenarioId } from "@/lib/scenarios/active-scenario-id";
import type { InitialScenarioDetail } from "@/lib/scenarios/initial-scenario-detail";
import { loadScenarioDetail } from "@/lib/scenarios/scenario-detail";
import type { ScenarioDetailApiResponse } from "@icecore/scenario-contracts";

/**
 * Reads the scenario the canvas opens first, for a page that has already
 * confirmed workspace access. The page hands this promise to the client
 * unawaited, so media signing and linked-scenario lookups stream in behind
 * the page instead of delaying it. It resolves null rather than rejecting;
 * the canvas then asks GET /api/scenarios/:id as it always has.
 *
 * Media signing is `deferred`: media not signed within the read's short budget
 * stays durable, `metadata.mediaDisplayUrlsPending` says so, and the canvas
 * asks again. The signing carries on after the response and fills the
 * read-URL cache, which the follow-up read is served from.
 */
export async function loadInitialScenarioDetail({
  workspaceId,
  summaries,
  requestedScenarioId,
}: {
  workspaceId: string;
  summaries: ReadonlyArray<{ _id: string }> | null;
  requestedScenarioId: string | null;
}): Promise<InitialScenarioDetail | null> {
  const scenarioId = pickActiveScenarioId(summaries ?? [], requestedScenarioId);
  if (!scenarioId) return null;

  // Taken before the read, so the detail's age is never understated.
  const loadedAt = Date.now();
  try {
    const detail = await loadScenarioDetail({
      workspaceId,
      scenarioId,
      mediaSigning: "deferred",
    });
    if (!detail) return null;
    return {
      scenarioId,
      loadedAt,
      // Exactly the JSON body the API route sends, dates as strings.
      response: JSON.parse(JSON.stringify(detail)) as ScenarioDetailApiResponse,
    };
  } catch (error) {
    logger.error("scenarios.initial_detail_failed", error, {
      workspaceId,
      scenarioId,
    });
    return null;
  }
}
