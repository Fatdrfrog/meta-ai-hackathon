import {
  isScenarioStatus,
  isScenarioViewport,
  normalizeScenarioEntryPolicy,
  normalizeScenarioMatchingRole,
  normalizeScenarioMode,
  normalizeScenarioPriority,
  normalizeScenarioTimezone,
  type ScenarioDetailResponseWarning,
  type ScenarioGraphNode,
} from "@icecore/scenario-contracts";
import {
  readNonEmptyString as normalizeOptionalString,
  readArray,
} from "@icecore/shared/lib/value-utils";
import { captureScenarioActivated } from "@/lib/scenarios/scenario-funnel";
import {
  BirthdayScenarioConflictError,
  findActiveBirthdayScenarioConflict,
  withBirthdayScenarioWriteFence,
} from "@/lib/campaign/campaign-birthday-scenario-guards";
import { retireCampaignDeliveryTasksForScenario } from "@/lib/campaign/campaign-control";
import {
  reconcileCampaignScenarioSchedules,
  retireCampaignScenarioSchedules,
} from "@/lib/campaign/campaign-node-schedules";
import { isBuilderBirthdayCampaignRoot } from "@/lib/campaign/campaign-runtime-utils";
import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import {
  normalizeScenarioModeForPersistence,
  normalizeScenarioNodesForPersistence,
} from "@/lib/scenarios/scenario-graph-persistence";
import {
  convertLegacyRoutingInTransaction,
  LegacyRoutingConversionError,
  loadCompletedWhatsAppFlowProvisioningOperations,
} from "@/lib/scenarios/legacy-routing-conversion-service";
import {
  scenarioRevisionFilter,
  normalizeScenarioRevision as normalizeTimestamp,
} from "@/lib/scenarios/scenario-revision";
import { hasNewLegacyActionRoutingAssignments } from "@/lib/scenarios/legacy-action-routing";
import {
  isLinkedConditionRevisionConflict,
  syncScenarioLinkedConditions,
} from "@/lib/scenarios/linked-conditions";
import { CURRENT_SCENARIO_GRAPH_SCHEMA_VERSION } from "@/lib/scenarios/scenario-graph-migrations";
import {
  collectScenarioWhatsAppFlowProviderSourceIds,
  createWhatsAppFlowEditableContentDigest,
  mergeServerOwnedWhatsAppFlowProjection,
} from "@/lib/scenarios/whatsapp-flow-projection";
import { startCampaignScheduleReconcileWorkflow } from "@/lib/temporal/campaign-schedule-reconcile";
import { isTemporalConfigured } from "@/lib/temporal/client";
import { loadCurrentWhatsAppSourceWabaBindings } from "@/lib/whatsapp/flows/source-rebind-guard";
import { assertOrdinaryScenarioWritePreservesWhatsAppQrBindings } from "@/lib/whatsapp/qr-entry-points/scenario-binding";
import {
  buildWhatsAppQrDetachPendingState,
  reconcileWhatsAppQrDetachPendingForScenario,
  WHATSAPP_QR_DETACH_NEXT_RETRY_AT_FIELD,
  WHATSAPP_QR_DETACH_PENDING_NODE_IDS_FIELD,
} from "@/lib/whatsapp/qr-entry-points/cleanup-retry";
import {
  commitScenarioActivationWithWhatsAppQrFence,
  loadWhatsAppQrActivationReadiness,
  WhatsAppQrActivationConflictError,
} from "@/lib/whatsapp/qr-entry-points/scenario-activation";
import {
  assertScenarioStoredGraphEnvelope,
  validateScenarioWriteGraph,
  type ScenarioGraphNodeRecord,
  type ScenarioGraphEdgeRecord,
  type ScenarioMutation,
} from "@/lib/scenarios/scenario-write-validation";
import { serializeCommittedScenarioDetail } from "@/lib/scenarios/scenario-detail";
import { ScenarioOperationError } from "@/lib/scenarios/scenario-operation-error";
import { admitBuilderBirthdayScenarioAudience } from "@/lib/scenarios/scenario-birthday-admission";
import { Scenario } from "@/models/scenario";
import { randomUUID } from "node:crypto";

const MAX_LINKED_CONDITION_RECONCILIATION_ATTEMPTS = 2;
const asScenarioGraphNodes = readArray<ScenarioGraphNodeRecord>;
const asScenarioGraphEdges = readArray<ScenarioGraphEdgeRecord>;

function resolveEffectiveGraphFromUpdate(params: {
  update: Record<string, unknown>;
  existing: Record<string, unknown>;
}): { nodes: ScenarioGraphNodeRecord[]; edges: ScenarioGraphEdgeRecord[] } {
  const nodes = Array.isArray(params.update.nodes)
    ? asScenarioGraphNodes(params.update.nodes)
    : asScenarioGraphNodes(params.existing.nodes);
  const edges = Array.isArray(params.update.edges)
    ? asScenarioGraphEdges(params.update.edges)
    : asScenarioGraphEdges(params.existing.edges);
  return { nodes, edges };
}

async function reconcileCommittedScenarioLinkedConditions(params: {
  workspaceId: string;
  scenarioId: string;
  committedScenario: Record<string, unknown>;
}): Promise<{
  scenario: Record<string, unknown>;
  warning: ScenarioDetailResponseWarning | null;
}> {
  let scenario = params.committedScenario;
  let reconciled = false;

  for (
    let attempt = 0;
    attempt < MAX_LINKED_CONDITION_RECONCILIATION_ATTEMPTS;
    attempt += 1
  ) {
    try {
      await syncScenarioLinkedConditions({
        workspaceId: params.workspaceId,
        scenarioId: params.scenarioId,
        scenario,
      });
      reconciled = true;
      break;
    } catch (error) {
      if (!isLinkedConditionRevisionConflict(error)) throw error;
      if (attempt === MAX_LINKED_CONDITION_RECONCILIATION_ATTEMPTS - 1) break;

      const currentScenario = await Scenario.findOne({
        _id: params.scenarioId,
        workspaceId: params.workspaceId,
        deletedAt: null,
      }).lean<Record<string, unknown> | null>({ defaults: false });
      if (!currentScenario) break;
      scenario = currentScenario;
    }
  }

  // Reconciliation can project linked IDs back into this parent through its
  // own CAS. Return one full persisted snapshot, never a new revision paired
  // with the primary write's older graph (including partial reconciliation).
  const currentScenario = await Scenario.findOne({
    _id: params.scenarioId,
    workspaceId: params.workspaceId,
    deletedAt: null,
  }).lean<Record<string, unknown> | null>({ defaults: false });

  return {
    scenario: currentScenario ?? scenario,
    warning: reconciled
      ? null
      : {
          code: "linked_condition_reconciliation_pending",
          message:
            "The scenario was saved, but linked sub-scenario routing could not be reconciled. Retry the save if the warning remains.",
          affectedScenarioIds: [params.scenarioId],
        },
  };
}

function isLegacyRoutingConversionRequest(body: unknown): body is {
  operation: "convert_legacy_action_routing";
  sourceActionNodeId: string;
  sourceNodeId: string;
  sourceKind: "post_action_condition" | "audience_filter";
  expectedUpdatedAt: string;
  actionOutcomes?: import("@icecore/scenario-contracts").ScenarioActionOutcomes;
  actionRunConditions?: import("@icecore/scenario-contracts").ScenarioActionRunConditions;
} {
  if (!body || typeof body !== "object") return false;
  const value = body as Record<string, unknown>;
  return (
    value.operation === "convert_legacy_action_routing" &&
    typeof value.sourceActionNodeId === "string" &&
    value.sourceActionNodeId.trim().length > 0 &&
    typeof value.sourceNodeId === "string" &&
    value.sourceNodeId.trim().length > 0 &&
    (value.sourceKind === "post_action_condition" ||
      value.sourceKind === "audience_filter") &&
    typeof value.expectedUpdatedAt === "string" &&
    value.expectedUpdatedAt.trim().length > 0
  );
}

/** Presence checks distinguish omitted fields from explicitly cleared metadata. */
function prepareScenarioPatch(
  body: Record<string, unknown>,
  userId: string
): Record<string, unknown> {
  const update: Record<string, unknown> = {
    updatedBy: userId,
    // Ensure runtime caches keyed by updatedAt always invalidate on save.
    updatedAt: new Date(),
  };

  if (typeof body?.name === "string" && body.name.trim()) {
    update.name = body.name.trim();
  }

  if (typeof body?.description === "string") {
    update.description = body.description;
  }

  if (isScenarioStatus(body?.status)) {
    update.status = body.status;
  }

  if ("mode" in (body || {})) {
    update.mode = normalizeScenarioMode(body?.mode);
  }

  if ("timezone" in (body || {})) {
    update.timezone = normalizeScenarioTimezone(body?.timezone);
  }

  if ("priority" in (body || {})) {
    update.priority = normalizeScenarioPriority(body?.priority);
  }

  if ("presetId" in (body || {})) {
    update.presetId = normalizeOptionalString(body?.presetId);
  }

  if ("presetVersion" in (body || {})) {
    update.presetVersion = normalizeOptionalString(body?.presetVersion);
  }

  if ("segmentKey" in (body || {})) {
    update.segmentKey = normalizeOptionalString(body?.segmentKey);
  }

  if ("matchingRole" in (body || {})) {
    update.matchingRole = normalizeScenarioMatchingRole(body?.matchingRole);
  }

  if ("entryPolicy" in (body || {})) {
    update.entryPolicy = normalizeScenarioEntryPolicy(body?.entryPolicy);
  }

  if (Array.isArray(body?.nodes)) {
    update.nodes = normalizeScenarioNodesForPersistence(body.nodes);
    update.graphSchemaVersion = CURRENT_SCENARIO_GRAPH_SCHEMA_VERSION;
  }

  if (Array.isArray(body?.edges)) {
    update.edges = body.edges;
  }

  if (isScenarioViewport(body?.viewport)) {
    update.viewport = body.viewport;
  }

  return update;
}

/** Preserve the existing non-blocking schedule dispatch after a successful commit. */
function dispatchScenarioCampaignUpdates(params: {
  workspaceId: string;
  scenarioId: string;
  existingScenario: Record<string, unknown>;
  updated: Record<string, unknown>;
}): void {
  const { workspaceId, scenarioId, existingScenario, updated } = params;
  const previousMode = String(existingScenario.mode || "").trim();
  const nextMode = String(updated.mode || "").trim();
  const nextStatus = String(updated.status || "").trim();
  const isBulkCampaign = nextMode === "bulk_campaign";
  // Builder birthday roots schedule from the graph while Scenario.mode stays
  // "conversation"; other builder saves start nothing.
  const hadBuilderBirthdayRoot = asScenarioGraphNodes(
    existingScenario.nodes
  ).some(isBuilderBirthdayCampaignRoot);
  const hasBuilderBirthdayRoot = asScenarioGraphNodes(updated.nodes).some(
    isBuilderBirthdayCampaignRoot
  );
  const ownsCampaignSchedules =
    isBulkCampaign || hadBuilderBirthdayRoot || hasBuilderBirthdayRoot;

  if (ownsCampaignSchedules) {
    const sid = String(updated._id ?? scenarioId).trim();
    if (isTemporalConfigured()) {
      void startCampaignScheduleReconcileWorkflow({
        workspaceId,
        scenarioId: sid,
      }).catch(async error => {
        logger.error(
          "scenario.schedule_reconcile_temporal_start_failed",
          error,
          { workspaceId, scenarioId: sid }
        );
        await reconcileCampaignScenarioSchedules(
          updated as Record<string, unknown>,
          { now: new Date() }
        ).catch(reconcileError =>
          logger.error(
            "scenario.schedule_reconcile_inline_failed",
            reconcileError,
            { workspaceId, scenarioId: sid }
          )
        );
      });
    } else {
      void reconcileCampaignScenarioSchedules(
        updated as Record<string, unknown>,
        {
          now: new Date(),
        }
      ).catch(error =>
        logger.error("scenario.schedule_reconcile_inline_failed", error, {
          workspaceId,
          scenarioId: sid,
        })
      );
    }
  } else if (previousMode === "bulk_campaign") {
    void retireCampaignScenarioSchedules({
      workspaceId,
      scenarioId,
      // Query all persisted schedules: the former campaign root may have
      // been removed from the graph that is being saved.
      timezone:
        typeof updated.timezone === "string"
          ? updated.timezone
          : typeof existingScenario.timezone === "string"
            ? existingScenario.timezone
            : undefined,
      now: new Date(),
    }).catch(error =>
      logger.error("scenario.schedule_retire_failed", error, {
        workspaceId,
        scenarioId,
      })
    );
  }

  if (
    (previousMode === "bulk_campaign" || ownsCampaignSchedules) &&
    nextStatus !== "active"
  ) {
    void retireCampaignDeliveryTasksForScenario({
      workspaceId,
      scenarioId,
      reason: "scenario_inactive",
      now: new Date(),
    }).catch(error =>
      logger.error("scenario.delivery_tasks_retire_failed", error, {
        workspaceId,
        scenarioId,
      })
    );
  }
}

/** Save a sparse authored patch while retaining provider-owned projections. */
export async function saveScenario(
  actor: { workspaceId: string; scenarioId: string; userId: string },
  body: Record<string, unknown>
) {
  const { workspaceId, scenarioId, userId } = actor;
  const update = prepareScenarioPatch(body, userId);

  await connectDB();

  const existingScenario = await Scenario.findOne({
    _id: scenarioId,
    workspaceId,
    deletedAt: null,
  }).lean<Record<string, unknown> | null>({ defaults: false });
  if (!existingScenario) {
    throw new ScenarioOperationError({ kind: "not_found" });
  }

  const expectedUpdatedAt = normalizeTimestamp(body?.expectedUpdatedAt);
  const currentUpdatedAt = normalizeTimestamp(existingScenario.updatedAt);
  if (
    expectedUpdatedAt &&
    currentUpdatedAt &&
    expectedUpdatedAt.getTime() !== currentUpdatedAt.getTime()
  ) {
    throw new ScenarioOperationError({
      kind: "revision_conflict",
      currentUpdatedAt,
      operation: "save",
    });
  }

  const effectiveStatus = isScenarioStatus(update.status)
    ? update.status
    : isScenarioStatus(existingScenario.status)
      ? existingScenario.status
      : "draft";

  assertScenarioStoredGraphEnvelope(existingScenario);

  if (Array.isArray(update.nodes)) {
    update.nodes = mergeServerOwnedWhatsAppFlowProjection({
      incomingNodes: update.nodes as ScenarioGraphNode[],
      storedNodes: asScenarioGraphNodes(
        existingScenario.nodes
      ) as ScenarioGraphNode[],
      digestEditableConfig: createWhatsAppFlowEditableContentDigest,
      preserveTemplateProviderBindingOnContentChange:
        effectiveStatus !== "active",
    });
  }

  let removedWhatsAppQrNodeIds: string[] = [];
  if (Array.isArray(update.nodes)) {
    const qrBindingWrite =
      assertOrdinaryScenarioWritePreservesWhatsAppQrBindings({
        previousNodes: asScenarioGraphNodes(existingScenario.nodes).flatMap(
          node =>
            node.id && node.data
              ? [
                  {
                    id: String(node.id),
                    data: node.data as import("@icecore/scenario-contracts").ScenarioNodeData,
                  },
                ]
              : []
        ),
        nextNodes: asScenarioGraphNodes(update.nodes).flatMap(node =>
          node.id && node.data
            ? [
                {
                  id: String(node.id),
                  data: node.data as import("@icecore/scenario-contracts").ScenarioNodeData,
                },
              ]
            : []
        ),
      });
    if (!qrBindingWrite.ok) {
      throw new ScenarioOperationError({
        kind: "qr_binding_changed",
        code: qrBindingWrite.code,
        nodeId: qrBindingWrite.nodeId,
        change: qrBindingWrite.change,
      });
    }
    removedWhatsAppQrNodeIds = qrBindingWrite.removedNodeIds;
  }

  if (body?.operation === "convert_legacy_action_routing") {
    if (!isLegacyRoutingConversionRequest(body)) {
      throw new ScenarioOperationError({ kind: "legacy_conversion_invalid" });
    }

    try {
      const conversion = await convertLegacyRoutingInTransaction({
        scenarioId,
        workspaceId,
        updatedBy: userId,
        expectedUpdatedAt: body.expectedUpdatedAt,
        conversions: [
          {
            sourceActionNodeId: body.sourceActionNodeId,
            sourceNodeId: body.sourceNodeId,
            sourceKind: body.sourceKind,
            actionOutcomes: body.actionOutcomes,
            actionRunConditions: body.actionRunConditions,
          },
        ],
      });
      return serializeCommittedScenarioDetail({
        workspaceId,
        scenario: conversion.scenario,
      });
    } catch (error) {
      if (error instanceof LegacyRoutingConversionError) {
        if (error.committed && error.committedResult) {
          return serializeCommittedScenarioDetail({
            workspaceId,
            scenario: error.committedResult.scenario,
            warnings: error.committedResult.postCommitWarnings,
          });
        }
        // Mapped operation errors skip the route's error log, so record the
        // failure code here to keep repeated conversion failures diagnosable.
        logger.warn("scenario.legacy_routing_conversion_failed", {
          code: error.code,
          status: error.status,
          scenarioId,
          workspaceId,
          sourceActionNodeId: body.sourceActionNodeId,
          sourceKind: body.sourceKind,
        });
        throw new ScenarioOperationError({
          kind: "legacy_conversion_failed",
          error,
        });
      }
      throw error;
    }
  }

  const hasGraphPayload =
    Array.isArray(body?.nodes) || Array.isArray(body?.edges);
  const shouldValidateGraph = hasGraphPayload || effectiveStatus === "active";
  const effectiveGraph =
    shouldValidateGraph || "mode" in update
      ? resolveEffectiveGraphFromUpdate({
          update,
          existing: existingScenario,
        })
      : null;
  if (
    hasGraphPayload &&
    effectiveGraph &&
    hasNewLegacyActionRoutingAssignments({
      previousNodes: asScenarioGraphNodes(existingScenario.nodes),
      previousEdges: asScenarioGraphEdges(existingScenario.edges),
      nextNodes: effectiveGraph.nodes,
      nextEdges: effectiveGraph.edges,
    })
  ) {
    throw new ScenarioOperationError({ kind: "legacy_assignment_forbidden" });
  }
  if (shouldValidateGraph && effectiveGraph) {
    const completedWhatsAppFlowProvisioningOperations =
      effectiveStatus === "active"
        ? await loadCompletedWhatsAppFlowProvisioningOperations({
            workspaceId,
            scenarioId,
            nodes: effectiveGraph.nodes,
          })
        : [];
    const currentWhatsAppSourceWabaBindings =
      effectiveStatus === "active"
        ? await loadCurrentWhatsAppSourceWabaBindings({
            workspaceId,
            sourceIds: collectScenarioWhatsAppFlowProviderSourceIds(
              effectiveGraph.nodes,
              completedWhatsAppFlowProvisioningOperations.map(
                operation => operation.sourceId
              )
            ),
          })
        : {};
    const whatsappQrEntryPointReadiness =
      effectiveStatus === "active"
        ? await loadWhatsAppQrActivationReadiness({
            workspaceId,
            scenarioId,
            nodes: effectiveGraph.nodes,
          })
        : {};

    await validateScenarioWriteGraph({
      workspaceId,
      scenarioId,
      nodes: effectiveGraph.nodes,
      edges: effectiveGraph.edges,
      options: {
        mode: effectiveStatus === "active" ? "runnable" : "draft",
        ...(normalizeScenarioMode(update.mode ?? existingScenario.mode) ===
        "bulk_campaign"
          ? { scenarioMode: "bulk_campaign" as const }
          : {}),
        ...(effectiveStatus === "active"
          ? {
              completedWhatsAppFlowProvisioningOperations,
              currentWhatsAppSourceWabaBindings,
              whatsappQrEntryPointReadiness,
            }
          : {}),
      },
    });
  }

  if (effectiveGraph) {
    const mode = normalizeScenarioModeForPersistence(
      update.mode ?? existingScenario.mode,
      effectiveGraph.nodes
    );
    if (
      "mode" in update ||
      mode !== normalizeScenarioMode(existingScenario.mode)
    ) {
      update.mode = mode;
    }
  }

  const birthdayGraph = resolveEffectiveGraphFromUpdate({
    update,
    existing: existingScenario,
  });
  await admitBuilderBirthdayScenarioAudience({
    workspaceId,
    mode: update.mode ?? existingScenario.mode,
    status: effectiveStatus,
    nodes: birthdayGraph.nodes,
    edges: birthdayGraph.edges,
    previous: {
      mode: existingScenario.mode,
      status: existingScenario.status,
      nodes: asScenarioGraphNodes(existingScenario.nodes),
      edges: asScenarioGraphEdges(existingScenario.edges),
    },
  });

  const birthdayConflict = await findActiveBirthdayScenarioConflict({
    workspaceId,
    scenarioId,
    scenario: {
      ...existingScenario,
      ...update,
    },
  });
  if (birthdayConflict) {
    throw new ScenarioOperationError({
      kind: "birthday_conflict",
      scenarioId: birthdayConflict.scenarioId,
      name: birthdayConflict.name || null,
    });
  }

  const qrDetachPendingState = hasGraphPayload
    ? buildWhatsAppQrDetachPendingState({
        existingPendingNodeIds:
          existingScenario[WHATSAPP_QR_DETACH_PENDING_NODE_IDS_FIELD],
        previousNodes: existingScenario.nodes,
        nextNodes: resolveEffectiveGraphFromUpdate({
          update,
          existing: existingScenario,
        }).nodes,
        removedNodeIds: removedWhatsAppQrNodeIds,
      })
    : null;
  if (qrDetachPendingState?.pendingNodeIds.length) {
    update[WHATSAPP_QR_DETACH_PENDING_NODE_IDS_FIELD] =
      qrDetachPendingState.pendingNodeIds;
    update[WHATSAPP_QR_DETACH_NEXT_RETRY_AT_FIELD] = update.updatedAt;
  }
  const shouldClearQrDetachPendingMarker =
    qrDetachPendingState !== null &&
    qrDetachPendingState.pendingNodeIds.length === 0 &&
    (Object.prototype.hasOwnProperty.call(
      existingScenario,
      WHATSAPP_QR_DETACH_PENDING_NODE_IDS_FIELD
    ) ||
      Object.prototype.hasOwnProperty.call(
        existingScenario,
        WHATSAPP_QR_DETACH_NEXT_RETRY_AT_FIELD
      ));
  const scenarioMutation: ScenarioMutation = { $set: update };
  if (shouldClearQrDetachPendingMarker) {
    scenarioMutation.$unset = {
      [WHATSAPP_QR_DETACH_PENDING_NODE_IDS_FIELD]: 1,
      [WHATSAPP_QR_DETACH_NEXT_RETRY_AT_FIELD]: 1,
    };
  }

  const existingStatus = isScenarioStatus(existingScenario.status)
    ? existingScenario.status
    : "draft";
  const isInactiveToActive =
    existingStatus !== "active" && effectiveStatus === "active";
  let updated: Record<string, unknown> | null;
  // Created outside withTransaction so Mongo retries keep the same QR fence.
  const activationFenceToken = isInactiveToActive ? randomUUID() : null;
  try {
    updated = await withBirthdayScenarioWriteFence({
      workspaceId,
      scenarioId,
      scenario: { ...existingScenario, ...update },
      commit: async session => {
        if (isInactiveToActive && activationFenceToken) {
          return commitScenarioActivationWithWhatsAppQrFence({
            workspaceId,
            scenarioId,
            expectedUpdatedAt: existingScenario.updatedAt,
            nodes: resolveEffectiveGraphFromUpdate({
              update,
              existing: existingScenario,
            }).nodes,
            mutation: scenarioMutation,
            activationFenceToken,
            ...(session ? { session } : {}),
          });
        }
        const committed = await Scenario.findOneAndUpdate(
          {
            _id: scenarioId,
            workspaceId,
            deletedAt: null,
            ...scenarioRevisionFilter(existingScenario.updatedAt),
          },
          scenarioMutation,
          { new: true, ...(session ? { session } : {}) }
        ).lean<Record<string, unknown> | null>({ defaults: false });
        if (session && !committed) {
          throw new ScenarioOperationError({
            kind: "revision_conflict",
            currentUpdatedAt,
            operation: "save",
          });
        }
        return committed;
      },
    });
  } catch (error) {
    if (error instanceof BirthdayScenarioConflictError) {
      throw new ScenarioOperationError({
        kind: "birthday_conflict",
        scenarioId: error.conflict.scenarioId,
        name: error.conflict.name || null,
      });
    }
    if (error instanceof WhatsAppQrActivationConflictError) {
      throw new ScenarioOperationError({
        kind: "qr_activation_conflict",
        message: error.message,
      });
    }
    throw error;
  }

  if (!updated) {
    throw new ScenarioOperationError({
      kind: "revision_conflict",
      currentUpdatedAt,
      operation: "save",
    });
  }

  let linkedConditionWarning: ScenarioDetailResponseWarning | null = null;
  if (hasGraphPayload) {
    const reconciliation = await reconcileCommittedScenarioLinkedConditions({
      workspaceId,
      scenarioId,
      committedScenario: updated,
    });
    updated = reconciliation.scenario;
    linkedConditionWarning = reconciliation.warning;
  }

  let whatsAppQrDetachWarning: ScenarioDetailResponseWarning | null = null;
  if (qrDetachPendingState?.pendingNodeIds.length) {
    try {
      const detachResult = await reconcileWhatsAppQrDetachPendingForScenario({
        workspaceId,
        scenarioId,
      });
      if (detachResult.failedNodeIds.length > 0) {
        whatsAppQrDetachWarning = {
          code: "whatsapp_qr_entry_point_detach_pending",
          message:
            "The scenario was saved, but one or more WhatsApp QR entry points could not be detached. Cleanup will be retried automatically.",
          affectedNodeIds: detachResult.failedNodeIds,
        };
      }
    } catch (error) {
      logger.error("scenario.whatsapp_qr_detach_removed_nodes_failed", error, {
        workspaceId,
        scenarioId,
        pendingNodeIds: qrDetachPendingState.pendingNodeIds,
      });
      whatsAppQrDetachWarning = {
        code: "whatsapp_qr_entry_point_detach_pending",
        message:
          "The scenario was saved, but WhatsApp QR cleanup could not complete. Cleanup will be retried automatically.",
        affectedNodeIds: qrDetachPendingState.pendingNodeIds,
      };
    }
  }

  dispatchScenarioCampaignUpdates({
    workspaceId,
    scenarioId,
    existingScenario,
    updated,
  });

  if (isInactiveToActive) {
    await captureScenarioActivated({
      userId,
      workspaceId,
      scenarioId,
      nodes: updated?.nodes,
    });
  }

  return serializeCommittedScenarioDetail({
    workspaceId,
    scenario: updated,
    warnings: [linkedConditionWarning, whatsAppQrDetachWarning].filter(
      (warning): warning is ScenarioDetailResponseWarning => warning !== null
    ),
  });
}
