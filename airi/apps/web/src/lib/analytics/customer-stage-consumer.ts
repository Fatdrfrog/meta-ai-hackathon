import "server-only";
import Customer from "@/models/customer";
import CustomerEvent from "@/models/customer-event";
import type { Types } from "mongoose";
import {
  decodeCustomerStageEnvelope,
  type CustomerStageEnvelope,
} from "./customer-stage-transition";
import {
  readAnalyticsTransitionCoverage,
  rebuildAnalyticsTransitionSnapshots,
  watchAnalyticsTransitionSource,
  type ServiceLifecycleChange,
  type ServiceLifecycleLease,
  ANALYTICS_GLOBAL_CHECKPOINT,
  isAnalyticsWorkspaceId,
  type AnalyticsInvalidEvent,
} from "./service-lifecycle-consumer";

export async function materializeCustomerStageEvent(
  event: CustomerStageEnvelope,
  evidence:
    | "change_stream"
    | "snapshot_recovery"
    | "source_write" = "source_write"
) {
  const idempotencyKey = `customer-stage:${event.eventId}`;
  return CustomerEvent.findOneAndUpdate(
    { workspaceId: event.workspaceId, idempotencyKey },
    {
      $setOnInsert: {
        workspaceId: event.workspaceId,
        customerId: event.customerId,
        conversationId: event.conversationId,
        type: event.previousStage ? "stage_changed" : "stage_snapshot",
        occurredAt: event.occurredAt,
        payload: {
          stage: event.stage,
          previousStage: event.previousStage,
          source: event.source,
          stageRevision: event.revision,
          stageEventId: event.eventId,
          captureEvidence: evidence,
        },
        actor: event.actor,
        idempotencyKey,
      },
    },
    { upsert: true, new: true }
  );
}

export async function processCustomerStageChange({
  workspaceId,
  change,
  persistEvent = materializeCustomerStageEvent,
  checkpoint,
  invalidEvent,
}: {
  workspaceId: string;
  change: ServiceLifecycleChange;
  persistEvent?: typeof materializeCustomerStageEvent;
  checkpoint: (token: Record<string, unknown>) => Promise<unknown>;
  invalidEvent?: AnalyticsInvalidEvent;
}) {
  let event: CustomerStageEnvelope | null;
  try {
    event = decodeCustomerStageEnvelope(
      change.operationType === "update"
        ? change.updateDescription?.updatedFields?.crm_stage_event
        : ["insert", "replace"].includes(change.operationType)
          ? change.fullDocument?.crm_stage_event
          : null
    );
  } catch (error) {
    if (workspaceId !== ANALYTICS_GLOBAL_CHECKPOINT || !invalidEvent)
      throw error;
    await invalidEvent(error);
    await checkpoint(change._id);
    return;
  }
  const global = workspaceId === ANALYTICS_GLOBAL_CHECKPOINT;
  // A customer written without a stage (the schema-default null) is not a transition.
  if (global && event && !isAnalyticsWorkspaceId(event.workspaceId)) {
    const cause = new Error("Invalid analytics event workspace");
    if (!invalidEvent) throw cause;
    await invalidEvent(cause);
    await checkpoint(change._id);
    return;
  }
  if (event && (global || event.workspaceId === workspaceId))
    await persistEvent(event, "change_stream");
  await checkpoint(change._id);
}

export function rebuildCustomerStageSnapshots({
  workspaceId,
  batchSize = 500,
  lease,
  signal,
}: {
  workspaceId: string;
  batchSize?: number;
  lease?: ServiceLifecycleLease;
  signal?: AbortSignal;
}) {
  return rebuildAnalyticsTransitionSnapshots({
    workspaceId,
    batchSize,
    lease,
    signal,
    source: "customer_stage",
    loadRows: async (cursor, limit) =>
      await Customer.find({
        workspaceId,
        ...(cursor ? { _id: { $gt: cursor } } : {}),
      })
        .select("_id crm_stage_event")
        .sort({ _id: 1 })
        .limit(limit)
        .lean<{ _id: Types.ObjectId; crm_stage_event?: unknown }[]>(),
    persistRow: async row => {
      const event = decodeCustomerStageEnvelope(row.crm_stage_event);
      if (event?.workspaceId === workspaceId)
        await materializeCustomerStageEvent(event, "snapshot_recovery");
    },
  });
}
export const readCustomerStageCoverage = (workspaceId: string) =>
  readAnalyticsTransitionCoverage(workspaceId, "customer_stage");
export function watchCustomerStageTransitions({
  workspaceId,
  signal,
  maxEvents,
  snapshotBatchSize = 500,
  logger,
}: {
  workspaceId: string;
  signal?: AbortSignal;
  maxEvents?: number;
  snapshotBatchSize?: number;
  logger?: Parameters<typeof watchAnalyticsTransitionSource>[0]["logger"];
}) {
  return watchAnalyticsTransitionSource({
    workspaceId,
    signal,
    maxEvents,
    logger,
    source: "customer_stage",
    collection: Customer.collection,
    eventKeyField: "crm_stage_event_key",
    processChange: (change, checkpoint, invalidEvent) =>
      processCustomerStageChange({
        workspaceId,
        change,
        checkpoint,
        invalidEvent,
      }),
    rebuildSnapshots: lease =>
      workspaceId === ANALYTICS_GLOBAL_CHECKPOINT
        ? Promise.resolve({ scanned: 0, complete: false })
        : rebuildCustomerStageSnapshots({
            workspaceId,
            batchSize: snapshotBatchSize,
            lease,
            signal,
          }),
  });
}
