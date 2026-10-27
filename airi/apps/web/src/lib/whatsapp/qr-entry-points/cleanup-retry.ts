import "server-only";

import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import { Scenario } from "@/models/scenario";
import {
  WhatsAppQrEntryPoint,
  type WhatsAppQrEntryPointRecord,
} from "@/models/whatsapp-qr-entry-point";
import { readUniqueStringArray } from "@icecore/shared/lib/value-utils";

import {
  unassignWhatsAppQrEntryPointsForRemovedNodes,
  WhatsAppQrUnassignError,
} from "./lifecycle";
import {
  collectWhatsAppQrGraphBindings,
  type WhatsAppQrGraphBinding,
} from "./scenario-binding";

export const WHATSAPP_QR_DETACH_PENDING_NODE_IDS_FIELD =
  "whatsappQrDetachPendingNodeIds" as const;
export const WHATSAPP_QR_DETACH_NEXT_RETRY_AT_FIELD =
  "whatsappQrDetachNextRetryAt" as const;
const WHATSAPP_QR_DETACH_RETRY_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_WHATSAPP_QR_DETACH_RETRY_BATCH_SIZE = 50;
const MAX_WHATSAPP_QR_DETACH_RETRY_BATCH_SIZE = 100;

type ScenarioGraphNodeRecord = { id?: string; data?: Record<string, unknown> };

function collectQrBindings(value: unknown): WhatsAppQrGraphBinding[] {
  if (!Array.isArray(value)) return [];
  return collectWhatsAppQrGraphBindings(
    (value as ScenarioGraphNodeRecord[]).flatMap(node =>
      node.id && node.data
        ? [
            {
              id: String(node.id),
              data: node.data as import("@icecore/scenario-contracts").ScenarioNodeData,
            },
          ]
        : []
    )
  );
}

function collectQrNodeIds(value: unknown): string[] {
  return collectQrBindings(value).map(binding => binding.nodeId);
}

export function buildWhatsAppQrDetachPendingState(params: {
  existingPendingNodeIds: unknown;
  previousNodes: unknown;
  nextNodes: unknown;
  removedNodeIds?: readonly string[];
}): { pendingNodeIds: string[]; removedNodeIds: string[] } {
  const previousQrNodeIds = collectQrNodeIds(params.previousNodes);
  const nextQrNodeIdSet = new Set(collectQrNodeIds(params.nextNodes));
  const removedNodeIds = Array.from(
    new Set([
      ...previousQrNodeIds.filter(nodeId => !nextQrNodeIdSet.has(nodeId)),
      ...readUniqueStringArray(params.removedNodeIds),
    ])
  ).filter(nodeId => !nextQrNodeIdSet.has(nodeId));
  const pendingNodeIds = Array.from(
    new Set([
      ...readUniqueStringArray(params.existingPendingNodeIds),
      ...removedNodeIds,
    ])
  );

  return { pendingNodeIds, removedNodeIds };
}

export async function markWhatsAppQrDetachPendingNodes(params: {
  workspaceId: string;
  scenarioId: string;
  nodeIds: readonly string[];
  now?: Date;
}): Promise<void> {
  const workspaceId = params.workspaceId.trim();
  const scenarioId = params.scenarioId.trim();
  if (!workspaceId || !scenarioId) {
    throw new Error("Workspace id and scenario id are required");
  }
  const nodeIds = readUniqueStringArray(params.nodeIds);
  if (nodeIds.length === 0) return;

  await connectDB();
  const result = await Scenario.updateOne(
    { _id: scenarioId, workspaceId },
    {
      $addToSet: {
        [WHATSAPP_QR_DETACH_PENDING_NODE_IDS_FIELD]: { $each: nodeIds },
      },
      $min: {
        [WHATSAPP_QR_DETACH_NEXT_RETRY_AT_FIELD]: params.now ?? new Date(),
      },
    },
    { timestamps: false }
  );
  if (result.matchedCount !== 1) {
    throw new Error("Scenario was not found for WhatsApp QR detach retry");
  }
}

export async function reconcileWhatsAppQrDetachPendingForScenario(params: {
  workspaceId: string;
  scenarioId: string;
  now?: Date;
}): Promise<{ attemptedNodeIds: string[]; failedNodeIds: string[] }> {
  const workspaceId = params.workspaceId.trim();
  const scenarioId = params.scenarioId.trim();
  if (!workspaceId || !scenarioId) {
    throw new Error("Workspace id and scenario id are required");
  }

  await connectDB();
  const session = await Scenario.startSession();
  let result = {
    attemptedNodeIds: [] as string[],
    failedNodeIds: [] as string[],
  };

  try {
    await session.withTransaction(async () => {
      const scenarioQuery = Scenario.findOne({
        _id: scenarioId,
        workspaceId,
        [`${WHATSAPP_QR_DETACH_PENDING_NODE_IDS_FIELD}.0`]: {
          $exists: true,
        },
      });
      scenarioQuery.session(session);
      const scenario = await scenarioQuery.lean<Record<string, unknown> | null>(
        { defaults: false }
      );
      if (!scenario) return;

      const pendingNodeIds = readUniqueStringArray(
        scenario[WHATSAPP_QR_DETACH_PENDING_NODE_IDS_FIELD]
      );
      if (pendingNodeIds.length === 0) return;

      const currentBindingsByNodeId = new Map(
        (scenario.deletedAt ? [] : collectQrBindings(scenario.nodes)).map(
          binding => [binding.nodeId, binding.entryPointId] as const
        )
      );
      const projectionQuery = WhatsAppQrEntryPoint.find({
        workspaceId,
        scenarioId,
        nodeId: { $in: pendingNodeIds },
      }).select({ entryPointId: 1, nodeId: 1 });
      projectionQuery.session(session);
      const projectedEntryPoints =
        await projectionQuery.lean<WhatsAppQrEntryPointRecord[]>();
      const projectionsByNodeId = new Map<
        string,
        WhatsAppQrEntryPointRecord[]
      >();
      for (const entryPoint of projectedEntryPoints) {
        if (!entryPoint.nodeId) continue;
        const projections = projectionsByNodeId.get(entryPoint.nodeId) ?? [];
        projections.push(entryPoint);
        projectionsByNodeId.set(entryPoint.nodeId, projections);
      }
      const attemptedNodeIds = pendingNodeIds.filter(nodeId => {
        const graphEntryPointId = currentBindingsByNodeId.get(nodeId);
        const projections = projectionsByNodeId.get(nodeId) ?? [];
        return !(
          graphEntryPointId &&
          projections.length === 1 &&
          projections[0]?.entryPointId === graphEntryPointId
        );
      });
      let failedNodeIds: string[] = [];

      if (attemptedNodeIds.length > 0) {
        try {
          await unassignWhatsAppQrEntryPointsForRemovedNodes({
            workspaceId,
            scenarioId,
            removedNodeIds: attemptedNodeIds,
            session,
          });
        } catch (error) {
          failedNodeIds =
            error instanceof WhatsAppQrUnassignError
              ? readUniqueStringArray(error.failedNodeIds).filter(nodeId =>
                  attemptedNodeIds.includes(nodeId)
                )
              : attemptedNodeIds;
          logger.error("whatsapp_qr.unassign_retry_attempt_failed", error, {
            workspaceId,
            scenarioId,
            failedNodeIds,
          });
        }
      }

      const now = params.now ?? new Date();
      const markerUpdate =
        failedNodeIds.length > 0
          ? {
              $set: {
                [WHATSAPP_QR_DETACH_PENDING_NODE_IDS_FIELD]: failedNodeIds,
                [WHATSAPP_QR_DETACH_NEXT_RETRY_AT_FIELD]: new Date(
                  now.getTime() + WHATSAPP_QR_DETACH_RETRY_DELAY_MS
                ),
              },
            }
          : {
              $unset: {
                [WHATSAPP_QR_DETACH_PENDING_NODE_IDS_FIELD]: 1,
                [WHATSAPP_QR_DETACH_NEXT_RETRY_AT_FIELD]: 1,
              },
            };
      const markerResult = await Scenario.updateOne(
        {
          _id: scenarioId,
          workspaceId,
          [WHATSAPP_QR_DETACH_PENDING_NODE_IDS_FIELD]: pendingNodeIds,
        },
        markerUpdate,
        { session, timestamps: false }
      );
      if (markerResult.matchedCount !== 1) {
        throw new Error("WhatsApp QR detach retry marker changed concurrently");
      }

      result = { attemptedNodeIds, failedNodeIds };
    });
    return result;
  } finally {
    await session.endSession();
  }
}

export async function processWhatsAppQrDetachPendingBatch(params?: {
  limit?: number;
  now?: Date;
}): Promise<{
  scanned: number;
  completed: number;
  pending: number;
  failed: number;
}> {
  const now = params?.now ?? new Date();
  const requestedLimit = Number.isFinite(params?.limit)
    ? Math.trunc(params?.limit as number)
    : DEFAULT_WHATSAPP_QR_DETACH_RETRY_BATCH_SIZE;
  const limit = Math.min(
    MAX_WHATSAPP_QR_DETACH_RETRY_BATCH_SIZE,
    Math.max(1, requestedLimit)
  );

  await connectDB();
  const scenarios = await Scenario.find({
    [`${WHATSAPP_QR_DETACH_PENDING_NODE_IDS_FIELD}.0`]: { $exists: true },
    [WHATSAPP_QR_DETACH_NEXT_RETRY_AT_FIELD]: { $lte: now },
  })
    .select({ _id: 1, workspaceId: 1 })
    .sort({ [WHATSAPP_QR_DETACH_NEXT_RETRY_AT_FIELD]: 1, _id: 1 })
    .limit(limit)
    .lean<Array<{ _id: unknown; workspaceId?: unknown }>>();

  let completed = 0;
  let pending = 0;
  let failed = 0;

  for (const scenario of scenarios) {
    const workspaceId = String(scenario.workspaceId ?? "").trim();
    const scenarioId = String(scenario._id ?? "").trim();

    try {
      const result = await reconcileWhatsAppQrDetachPendingForScenario({
        workspaceId,
        scenarioId,
        now,
      });
      if (result.failedNodeIds.length > 0) pending += 1;
      else completed += 1;
    } catch (error) {
      failed += 1;
      logger.error("whatsapp_qr.unassign_retry_scenario_failed", error, {
        workspaceId,
        scenarioId,
      });
    }
  }

  return { scanned: scenarios.length, completed, pending, failed };
}
