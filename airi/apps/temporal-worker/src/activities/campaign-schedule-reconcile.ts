import {
  assertContractVersion,
  CAMPAIGN_SCHEDULE_RECONCILE_WORKFLOW_CONTRACT_VERSION,
  type CampaignScheduleReconcileActivityInput,
  type CampaignScheduleReconcileWorkflowResult,
} from "@icecore/temporal";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import { Types } from "mongoose";

export async function campaignScheduleReconcileActivity(
  input: CampaignScheduleReconcileActivityInput,
): Promise<CampaignScheduleReconcileWorkflowResult> {
  assertContractVersion(
    input.contractVersion,
    { max: CAMPAIGN_SCHEDULE_RECONCILE_WORKFLOW_CONTRACT_VERSION },
    "campaign schedule reconcile",
  );

  const workspaceId = String(input.workspaceId || "").trim();
  const scenarioId = String(input.scenarioId || "").trim();
  if (!workspaceId || !scenarioId) {
    throw new Error("workspaceId and scenarioId are required");
  }

  if (!Types.ObjectId.isValid(scenarioId)) {
    throw new Error("Invalid scenarioId");
  }

  const connectDB = (await import("@/lib/mongoose")).default;
  const {
    reconcileCampaignScenarioSchedules,
    retireCampaignScenarioSchedules,
  } = await import("@/lib/campaign/campaign-node-schedules");

  await connectDB();

  const { Scenario } = await import("@/models/scenario");

  const scenario = await Scenario.findOne({
    _id: new Types.ObjectId(scenarioId),
    workspaceId,
  }).lean<Record<string, unknown> | null>();

  if (!scenario) {
    airiWorkerLogger.warn("airi.worker.campaign_schedule_reconcile", {
      note: "scenario_not_found",
      workspaceId,
      scenarioId,
    });
    return { reconciled: [], orphanedDeletes: [] };
  }

  airiWorkerLogger.info("airi.worker.campaign_schedule_reconcile", {
    note: "start",
    workspaceId,
    scenarioId,
  });

  const summary = scenario.deletedAt
    ? {
        reconciled: [],
        orphanedDeletes: await retireCampaignScenarioSchedules({
          workspaceId,
          scenarioId,
          timezone:
            typeof scenario.timezone === "string"
              ? scenario.timezone
              : undefined,
        }),
      }
    : await reconcileCampaignScenarioSchedules(
        scenario as Parameters<typeof reconcileCampaignScenarioSchedules>[0],
      );

  airiWorkerLogger.info("airi.worker.campaign_schedule_reconcile", {
    note: "complete",
    workspaceId,
    scenarioId,
    reconciledNodes: summary.reconciled.length,
    orphanedDeletes: summary.orphanedDeletes.length,
  });

  return summary;
}
