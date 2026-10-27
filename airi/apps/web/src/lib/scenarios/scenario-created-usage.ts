import { emitWorkspaceUsageDeltaBestEffort } from "@/lib/limits/company-usage-events";

/** The same creation event is used by save hooks and transaction-safe inserts. */
export function emitScenarioCreatedUsageBestEffort(scenario: {
  _id?: unknown;
  workspaceId?: unknown;
  status?: unknown;
  mode?: unknown;
  deletedAt?: unknown;
}): void {
  if (!scenario._id || !scenario.workspaceId || scenario.deletedAt) return;
  emitWorkspaceUsageDeltaBestEffort(
    {
      workspaceId: String(scenario.workspaceId),
      metric: "scenario_count",
      delta: 1,
      objectId: String(scenario._id),
      source: "scenario_model",
      metadata: {
        status: typeof scenario.status === "string" ? scenario.status : null,
        mode: typeof scenario.mode === "string" ? scenario.mode : null,
      },
    },
    { logContext: "Scenario.postSave" }
  );
}
