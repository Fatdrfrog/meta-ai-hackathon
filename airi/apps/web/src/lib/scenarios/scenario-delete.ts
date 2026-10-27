import type { SupabaseClient } from "@supabase/supabase-js";
import { retireCampaignDeliveryTasksForScenario } from "@/lib/campaign/campaign-control";
import { retireCampaignScenarioSchedules } from "@/lib/campaign/campaign-node-schedules";
import { isBuilderBirthdayCampaignRoot } from "@/lib/campaign/campaign-runtime-utils";
import { emitWorkspaceUsageDeltaBestEffort } from "@/lib/limits/company-usage-events";
import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import { collectWhatsAppQrTriggerNodeIds } from "@/lib/scenarios/graph-validation";
import { normalizeScenarioRevision as normalizeTimestamp } from "@/lib/scenarios/scenario-revision";
import { detachScenarioLinkedConditionsForScenarioDeletion } from "@/lib/scenarios/linked-conditions";
import { listWhatsAppQrScenarioSummaries } from "@/lib/whatsapp/qr-entry-points/queries";
import {
  markWhatsAppQrDetachPendingNodes,
  reconcileWhatsAppQrDetachPendingForScenario,
  WHATSAPP_QR_DETACH_NEXT_RETRY_AT_FIELD,
  WHATSAPP_QR_DETACH_PENDING_NODE_IDS_FIELD,
} from "@/lib/whatsapp/qr-entry-points/cleanup-retry";
import { ScenarioOperationError } from "@/lib/scenarios/scenario-operation-error";
import type { ScenarioGraphNodeRecord } from "@/lib/scenarios/scenario-write-validation";
import { Scenario } from "@/models/scenario";
import {
  readUniqueStringArray,
  readArray,
} from "@icecore/shared/lib/value-utils";

type ScenarioCleanupKind =
  | "campaign_delivery_tasks"
  | "campaign_schedules"
  | "linked_conditions"
  | "whatsapp_qr_entry_points";
export type ScenarioDeletionResult =
  | { status: "deleted" }
  | { status: "cleanup_pending"; pendingCleanup: ScenarioCleanupKind[] };
const asScenarioGraphNodes = readArray<ScenarioGraphNodeRecord>;

function collectScenarioWhatsAppQrNodeIds(
  scenario: Record<string, unknown>
): string[] {
  return collectWhatsAppQrTriggerNodeIds(
    asScenarioGraphNodes(scenario.nodes).flatMap(node => {
      if (!node.id || !node.data) return [];
      return [
        {
          id: String(node.id),
          data: node.data as import("@icecore/scenario-contracts").ScenarioNodeData,
        },
      ];
    })
  );
}

function resolveScenarioDeletionQrRetryNodeIds(params: {
  scenario: Record<string, unknown>;
  entryPointNodeIds: readonly string[];
}): string[] {
  const existingPendingNodeIds = readUniqueStringArray(
    params.scenario[WHATSAPP_QR_DETACH_PENDING_NODE_IDS_FIELD]
  );
  return Array.from(
    new Set([
      ...existingPendingNodeIds,
      ...collectScenarioWhatsAppQrNodeIds(params.scenario),
      ...readUniqueStringArray(params.entryPointNodeIds),
    ])
  );
}

export function prepareScenarioDeleteConfirmation(
  body: Record<string, unknown> | null
) {
  const confirmationToken =
    typeof body?.confirmationToken === "string"
      ? body.confirmationToken.trim()
      : "";
  const confirmedScenarioName =
    typeof body?.scenarioName === "string" ? body.scenarioName.trim() : "";
  const expectedUpdatedAt = normalizeTimestamp(body?.expectedUpdatedAt);

  if (
    confirmationToken !== "delete_scenario" ||
    confirmedScenarioName.length === 0
  ) {
    throw new ScenarioOperationError({ kind: "delete_confirmation_required" });
  }

  return { confirmedScenarioName, expectedUpdatedAt };
}

/** Tombstone once, then retry the existing cleanup owners idempotently. */
export async function deleteScenario(
  actor: {
    workspaceId: string;
    scenarioId: string;
    userId: string;
    supabase: SupabaseClient;
  },
  confirmation: ReturnType<typeof prepareScenarioDeleteConfirmation>
): Promise<ScenarioDeletionResult> {
  const { workspaceId, scenarioId, userId, supabase } = actor;
  const { confirmedScenarioName, expectedUpdatedAt } = confirmation;
  await connectDB();

  const existingScenario = await Scenario.findOne({
    _id: scenarioId,
    workspaceId,
  }).lean<Record<string, unknown> | null>({ defaults: false });

  if (!existingScenario) {
    throw new ScenarioOperationError({ kind: "not_found" });
  }
  const currentScenarioName =
    typeof existingScenario.name === "string"
      ? existingScenario.name.trim()
      : "";
  if (confirmedScenarioName !== currentScenarioName) {
    throw new ScenarioOperationError({ kind: "delete_confirmation_mismatch" });
  }

  const currentUpdatedAt = normalizeTimestamp(existingScenario.updatedAt);
  const alreadyDeleted = Boolean(existingScenario.deletedAt);
  if (
    !alreadyDeleted &&
    expectedUpdatedAt &&
    currentUpdatedAt &&
    expectedUpdatedAt.getTime() !== currentUpdatedAt.getTime()
  ) {
    throw new ScenarioOperationError({
      kind: "revision_conflict",
      currentUpdatedAt,
      operation: "delete",
    });
  }

  const qrEntryPointSummaries = await listWhatsAppQrScenarioSummaries({
    workspaceId,
    scenarioId,
  });
  const qrDeletionRetryNodeIds = resolveScenarioDeletionQrRetryNodeIds({
    scenario: existingScenario,
    entryPointNodeIds: Object.keys(qrEntryPointSummaries),
  });

  let deleted = existingScenario;
  if (!alreadyDeleted) {
    const deletedAt = new Date();
    const deletedResult = await Scenario.findOneAndUpdate(
      {
        _id: scenarioId,
        workspaceId,
        deletedAt: null,
        ...(currentUpdatedAt
          ? { updatedAt: currentUpdatedAt }
          : { updatedAt: { $exists: false } }),
      },
      {
        $set: {
          status: "draft",
          deletedAt,
          deletedBy: userId,
          updatedBy: userId,
          updatedAt: deletedAt,
          ...(qrDeletionRetryNodeIds.length > 0
            ? {
                [WHATSAPP_QR_DETACH_PENDING_NODE_IDS_FIELD]:
                  qrDeletionRetryNodeIds,
                [WHATSAPP_QR_DETACH_NEXT_RETRY_AT_FIELD]: deletedAt,
              }
            : {}),
        },
      },
      { new: true }
    ).lean<Record<string, unknown> | null>({ defaults: false });

    if (!deletedResult) {
      throw new ScenarioOperationError({
        kind: "revision_conflict",
        currentUpdatedAt,
        operation: "delete",
      });
    }
    deleted = deletedResult;
    emitWorkspaceUsageDeltaBestEffort(
      {
        workspaceId,
        metric: "scenario_count",
        delta: -1,
        objectId: scenarioId,
        source: "scenario_delete_route",
        metadata: {
          status: typeof deleted.status === "string" ? deleted.status : null,
          mode: typeof deleted.mode === "string" ? deleted.mode : null,
        },
      },
      { supabase, logContext: "Scenario.DELETE" }
    );
  } else if (qrDeletionRetryNodeIds.length > 0) {
    await markWhatsAppQrDetachPendingNodes({
      workspaceId,
      scenarioId,
      nodeIds: qrDeletionRetryNodeIds,
    });
  }

  const pendingCleanup: Array<
    | "campaign_delivery_tasks"
    | "campaign_schedules"
    | "linked_conditions"
    | "whatsapp_qr_entry_points"
  > = [];
  try {
    await detachScenarioLinkedConditionsForScenarioDeletion({
      workspaceId,
      scenarioId,
      expectedUpdatedAt: deleted.updatedAt,
    });
  } catch (err) {
    logger.error("scenario.linked_conditions_detach_failed", err, {
      workspaceId,
      scenarioId,
    });
    pendingCleanup.push("linked_conditions");
  }

  if (qrDeletionRetryNodeIds.length > 0) {
    try {
      const detachResult = await reconcileWhatsAppQrDetachPendingForScenario({
        workspaceId,
        scenarioId,
      });
      if (detachResult.failedNodeIds.length > 0) {
        pendingCleanup.push("whatsapp_qr_entry_points");
      }
    } catch (err) {
      logger.error("scenario.whatsapp_qr_detach_failed", err, {
        workspaceId,
        scenarioId,
      });
      pendingCleanup.push("whatsapp_qr_entry_points");
    }
  }

  const isLegacyBulkCampaign =
    String(deleted.mode || "").trim() === "bulk_campaign";
  const allDeletedNodes = Array.isArray(deleted.nodes)
    ? (deleted.nodes as Array<{
        id?: unknown;
        data?: Record<string, unknown>;
      }>)
    : [];
  // Builder scenarios keep Scenario.mode "conversation"; only their birthday
  // roots can hold a schedule.
  const deletedNodes = isLegacyBulkCampaign
    ? allDeletedNodes
    : allDeletedNodes.filter(isBuilderBirthdayCampaignRoot);
  const deletedTimezone =
    typeof deleted.timezone === "string" ? deleted.timezone : undefined;

  // Retire every scenario: retiring also reads the stored schedule records,
  // so one a failed reconcile left behind is retired even after the graph
  // lost its birthday root. Without records it makes no Temporal call.
  try {
    await retireCampaignScenarioSchedules({
      workspaceId,
      scenarioId,
      nodes: deletedNodes,
      timezone: deletedTimezone,
      now: new Date(),
    });
  } catch (err) {
    logger.error("scenario.deleted_schedule_retire_failed", err, {
      workspaceId,
      scenarioId,
    });
    pendingCleanup.push("campaign_schedules");
  }

  // Queued delivery tasks likewise outlive a birthday root an active save
  // removed, so retire them for every scenario. Without tasks it is a no-op.
  try {
    await retireCampaignDeliveryTasksForScenario({
      workspaceId,
      scenarioId,
      reason: "scenario_deleted",
      now: new Date(),
    });
  } catch (err) {
    logger.error("scenario.deleted_delivery_tasks_retire_failed", err, {
      workspaceId,
      scenarioId,
    });
    pendingCleanup.push("campaign_delivery_tasks");
  }

  if (pendingCleanup.length > 0) {
    return { status: "cleanup_pending", pendingCleanup };
  }

  return { status: "deleted" };
}
