import "server-only";

import connectDB from "@/lib/mongoose";
import {
  WhatsAppQrEntryPoint,
  type WhatsAppQrEntryPointRecord,
} from "@/models/whatsapp-qr-entry-point";
import type { ClientSession } from "mongoose";
import {
  readUniqueStringArray,
  requireNonEmptyString,
} from "@icecore/shared/lib/value-utils";

import { assertWhatsAppQrUnassignedWritesEnabled } from "./indexes";

const MAX_UNASSIGN_CAS_ATTEMPTS = 3;

export class WhatsAppQrUnassignError extends Error {
  readonly failedEntryPointIds: string[];
  readonly failedNodeIds: string[];

  constructor(
    failures: ReadonlyArray<{ entryPointId: string; nodeId: string }>
  ) {
    const failedEntryPointIds = Array.from(
      new Set(failures.map(failure => failure.entryPointId))
    );
    super(
      failedEntryPointIds.length === 1
        ? `WhatsApp QR entry point ${failedEntryPointIds[0]} could not be unassigned after ${MAX_UNASSIGN_CAS_ATTEMPTS} attempts`
        : `WhatsApp QR entry points ${failedEntryPointIds.join(", ")} could not be unassigned after ${MAX_UNASSIGN_CAS_ATTEMPTS} attempts`
    );
    this.name = "WhatsAppQrUnassignError";
    this.failedEntryPointIds = failedEntryPointIds;
    this.failedNodeIds = Array.from(
      new Set(failures.map(failure => failure.nodeId))
    );
  }
}

/**
 * Remove only the Scenario assignment projection. Provider lifecycle fields,
 * current-code identity and code history intentionally remain untouched.
 */
async function unassignEntryPointsWithCas(
  entryPoints: WhatsAppQrEntryPointRecord[],
  session?: ClientSession
): Promise<void> {
  const failures: Array<{ entryPointId: string; nodeId: string }> = [];

  for (const entryPoint of entryPoints) {
    if (
      typeof entryPoint.scenarioId !== "string" ||
      !entryPoint.scenarioId ||
      entryPoint.scenarioId.trim() !== entryPoint.scenarioId ||
      typeof entryPoint.nodeId !== "string" ||
      !entryPoint.nodeId ||
      entryPoint.nodeId.trim() !== entryPoint.nodeId
    ) {
      continue;
    }

    let expectedVersion = entryPoint.version;
    for (let attempt = 0; attempt < MAX_UNASSIGN_CAS_ATTEMPTS; attempt += 1) {
      const updateQuery = WhatsAppQrEntryPoint.findOneAndUpdate(
        {
          entryPointId: entryPoint.entryPointId,
          workspaceId: entryPoint.workspaceId,
          scenarioId: entryPoint.scenarioId,
          nodeId: entryPoint.nodeId,
          version: expectedVersion,
        },
        {
          $unset: { scenarioId: 1, nodeId: 1 },
          $set: { assignmentState: "unassigned" },
          $inc: { version: 1 },
        },
        { new: true, runValidators: true }
      );
      if (session) updateQuery.session(session);
      const updated =
        await updateQuery.lean<WhatsAppQrEntryPointRecord | null>();

      if (updated) break;

      const latestQuery = WhatsAppQrEntryPoint.findOne({
        entryPointId: entryPoint.entryPointId,
        workspaceId: entryPoint.workspaceId,
        scenarioId: entryPoint.scenarioId,
        nodeId: entryPoint.nodeId,
      }).select({
        entryPointId: 1,
        workspaceId: 1,
        scenarioId: 1,
        nodeId: 1,
        version: 1,
      });
      if (session) latestQuery.session(session);
      const latest =
        await latestQuery.lean<WhatsAppQrEntryPointRecord | null>();

      // A missing exact tuple means another transaction already unassigned or
      // moved the resource. Never clear the new owner.
      if (!latest) break;
      if (attempt === MAX_UNASSIGN_CAS_ATTEMPTS - 1) {
        failures.push({
          entryPointId: entryPoint.entryPointId,
          nodeId: entryPoint.nodeId,
        });
        break;
      }
      expectedVersion = latest.version;
    }
  }

  if (failures.length > 0) {
    throw new WhatsAppQrUnassignError(failures);
  }
}

async function loadAssignedEntryPoints(params: {
  workspaceId: string;
  scenarioId: string;
  nodeIds?: readonly string[];
  session?: ClientSession;
}): Promise<WhatsAppQrEntryPointRecord[]> {
  const filter: Record<string, unknown> = {
    workspaceId: params.workspaceId,
    scenarioId: params.scenarioId,
  };
  if (params.nodeIds) filter.nodeId = { $in: params.nodeIds };
  const query = WhatsAppQrEntryPoint.find(filter).select({
    entryPointId: 1,
    workspaceId: 1,
    scenarioId: 1,
    nodeId: 1,
    assignmentState: 1,
    version: 1,
  });
  if (params.session) query.session(params.session);
  return query.lean<WhatsAppQrEntryPointRecord[]>();
}

export async function unassignWhatsAppQrEntryPointsForRemovedNodes(params: {
  workspaceId: string;
  scenarioId: string;
  removedNodeIds: readonly string[];
  session?: ClientSession;
}): Promise<void> {
  const removedNodeIds = readUniqueStringArray(params.removedNodeIds);
  if (removedNodeIds.length === 0) return;

  const workspaceId = requireNonEmptyString(params.workspaceId, "Workspace id");
  const scenarioId = requireNonEmptyString(params.scenarioId, "Scenario id");
  await assertWhatsAppQrUnassignedWritesEnabled();
  await connectDB();

  const entryPoints = await loadAssignedEntryPoints({
    workspaceId,
    scenarioId,
    nodeIds: removedNodeIds,
    session: params.session,
  });
  await unassignEntryPointsWithCas(entryPoints, params.session);
}
