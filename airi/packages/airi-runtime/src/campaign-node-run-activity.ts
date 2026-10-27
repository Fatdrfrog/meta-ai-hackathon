import type {
  CampaignDeliveryDrainInput,
  CampaignDeliveryDrainResult,
  CampaignExecutionFinalizeInput,
  CampaignNodeRunActivityInput,
  CampaignNodeRunActivityResult,
} from "@icecore/temporal";
import { airiWorkerLogger } from "./logging";
import { createWebRequire } from "./internal/module-interop";

const requireWeb = createWebRequire(import.meta.url);

type CampaignNodeRunRuntimeModule = {
  executeCampaignNodeRun: (
    input: CampaignNodeRunActivityInput,
  ) => Promise<CampaignNodeRunActivityResult>;
};

type CampaignDeliveryRuntimeModule = {
  drainCampaignDeliveryTasks: (
    input: CampaignDeliveryDrainInput,
  ) => Promise<CampaignDeliveryDrainResult>;
  finalizeCampaignExecution: (
    input: CampaignExecutionFinalizeInput,
  ) => Promise<void>;
};

const nodeRunRuntime = requireWeb(
  "../../../apps/web/src/lib/campaign/campaign-node-run-runtime",
) as CampaignNodeRunRuntimeModule;
const deliveryRuntime = requireWeb(
  "../../../apps/web/src/lib/campaign/campaign-delivery-runtime",
) as CampaignDeliveryRuntimeModule;

export async function executeCampaignNodeRunActivity(
  input: CampaignNodeRunActivityInput,
): Promise<CampaignNodeRunActivityResult> {
  airiWorkerLogger.info("airi.worker.campaign_node_run", {
    note: "materialize_start",
    workspaceId: input.workspaceId,
    scenarioId: input.scenarioId,
    nodeId: input.nodeId,
    executionSource: input.executionSource || "scenario_schedule",
  });

  const result = await nodeRunRuntime.executeCampaignNodeRun(input);

  airiWorkerLogger.info("airi.worker.campaign_node_run", {
    note: "materialize_finish",
    workspaceId: input.workspaceId,
    scenarioId: input.scenarioId,
    nodeId: input.nodeId,
    campaignId: result.campaignId || null,
    outcome: result.status,
    candidates: result.candidates,
    created: result.created,
    pendingCount: result.pendingCount,
  });

  return result;
}

export async function executeCampaignDeliveryDrainActivity(
  input: CampaignDeliveryDrainInput,
): Promise<CampaignDeliveryDrainResult> {
  airiWorkerLogger.info("airi.worker.campaign_execution", {
    note: "drain_start",
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    batchLimit: input.batchLimit || null,
  });

  const result = await deliveryRuntime.drainCampaignDeliveryTasks(input);

  airiWorkerLogger.info("airi.worker.campaign_execution", {
    note: "drain_finish",
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    processed: result.processed,
    completed: result.completed,
    retried: result.retried,
    failedTerminal: result.failedTerminal,
    skipped: result.skipped,
    pendingCount: result.pendingCount,
    nextDispatchAt: result.nextDispatchAt || null,
  });

  return result;
}

export async function executeCampaignExecutionFinalizeActivity(
  input: CampaignExecutionFinalizeInput,
): Promise<void> {
  airiWorkerLogger.info("airi.worker.campaign_execution", {
    note: "finalize_start",
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
  });

  await deliveryRuntime.finalizeCampaignExecution(input);

  airiWorkerLogger.info("airi.worker.campaign_execution", {
    note: "finalize_finish",
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
  });
}
