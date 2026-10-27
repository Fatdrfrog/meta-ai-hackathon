import type { ScenarioDetailApiResponse } from "@icecore/scenario-contracts";

/**
 * The scenario a Scenarios page opens first, read while the page renders so
 * the canvas does not wait for hydration before asking for it.
 */
export type InitialScenarioDetail = {
  scenarioId: string;
  /** Server clock (ms since epoch) when the detail was read. */
  loadedAt: number;
  /** Exactly the JSON body GET /api/scenarios/:id returns for this scenario. */
  response: ScenarioDetailApiResponse;
};

/**
 * How long after `loadedAt` the canvas may adopt an initial detail instead of
 * asking for it again. The App Router replays cached page payloads on
 * back/forward, so an older one may predate the user's own saves.
 */
export const INITIAL_SCENARIO_DETAIL_MAX_AGE_MS = 60_000;
