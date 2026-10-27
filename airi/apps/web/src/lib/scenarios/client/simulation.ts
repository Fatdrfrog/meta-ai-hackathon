import {
  scenarioSimulationResultSchema,
  type ScenarioSimulationContext,
  type ScenarioSimulationEvent,
  type ScenarioSimulationGraph,
  type ScenarioSimulationResult,
  type ScenarioSimulationState,
} from "../scenario-simulation-types";
import { JSON_HEADERS, readResponseJson, errorMessageOrFallback } from "./http";

export async function simulateScenarioStepRequest(input: {
  workspaceId: string;
  draftScenario: ScenarioSimulationGraph;
  event: ScenarioSimulationEvent;
  state?: ScenarioSimulationState | null;
  context?: ScenarioSimulationContext;
  signal?: AbortSignal;
}): Promise<ScenarioSimulationResult> {
  const { signal, ...payload } = input;
  const response = await fetch("/api/scenarios/simulate", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
    signal,
  });
  const data = await readResponseJson(response);
  if (!response.ok)
    throw new Error(
      errorMessageOrFallback(data, "Unable to try this scenario")
    );
  const parsed = scenarioSimulationResultSchema.safeParse(data);
  if (!parsed.success) throw new Error("Invalid scenario preview response");
  return parsed.data as ScenarioSimulationResult;
}
