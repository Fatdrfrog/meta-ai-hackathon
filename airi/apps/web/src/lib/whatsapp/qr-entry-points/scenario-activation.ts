import type {
  ScenarioGraphNodeRecord,
  ScenarioMutation,
} from "@/lib/scenarios/scenario-write-validation";
import {
  loadWhatsAppQrEntryPointReadinessByBindings,
  type WhatsAppQrEntryPointReadinessEvidence,
} from "@/lib/whatsapp/qr-entry-points/queries";
import { collectWhatsAppQrGraphBindings } from "@/lib/whatsapp/qr-entry-points/scenario-binding";
import { Scenario } from "@/models/scenario";
import { WhatsAppQrCode } from "@/models/whatsapp-qr-code";
import type { ClientSession } from "mongoose";
import { scenarioRevisionFilter } from "@/lib/scenarios/scenario-revision";
export class WhatsAppQrActivationConflictError extends Error {
  constructor() {
    super(
      "WhatsApp QR readiness changed while the Scenario was activating. Refresh and try again."
    );
    this.name = "WhatsAppQrActivationConflictError";
  }
}

export async function loadWhatsAppQrActivationReadiness(params: {
  workspaceId: string;
  scenarioId: string;
  nodes: ScenarioGraphNodeRecord[];
  session?: ClientSession;
}): Promise<Record<string, WhatsAppQrEntryPointReadinessEvidence>> {
  const bindings = collectWhatsAppQrGraphBindings(
    params.nodes.flatMap(node =>
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
  if (bindings.length === 0) return {};
  return loadWhatsAppQrEntryPointReadinessByBindings({
    workspaceId: params.workspaceId,
    scenarioId: params.scenarioId,
    bindings,
    session: params.session,
  });
}

export async function commitScenarioActivationWithWhatsAppQrFence(params: {
  workspaceId: string;
  scenarioId: string;
  expectedUpdatedAt: unknown;
  nodes: ScenarioGraphNodeRecord[];
  mutation: ScenarioMutation;
  activationFenceToken: string;
  session?: ClientSession;
}): Promise<Record<string, unknown>> {
  const bindings = collectWhatsAppQrGraphBindings(
    params.nodes.flatMap(node =>
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
  const session = params.session ?? (await Scenario.startSession());
  let committed: Record<string, unknown> | null = null;

  try {
    const commit = async () => {
      const exactScenarioFilter = {
        _id: params.scenarioId,
        workspaceId: params.workspaceId,
        deletedAt: null,
        ...scenarioRevisionFilter(params.expectedUpdatedAt),
      };
      const currentQuery = Scenario.findOne(exactScenarioFilter).select({
        _id: 1,
        status: 1,
        updatedAt: 1,
      });
      currentQuery.session(session);
      const current = await currentQuery.lean<Record<string, unknown> | null>({
        defaults: false,
      });
      if (!current || current.status === "active") {
        throw new WhatsAppQrActivationConflictError();
      }

      const readiness = await loadWhatsAppQrEntryPointReadinessByBindings({
        workspaceId: params.workspaceId,
        scenarioId: params.scenarioId,
        bindings,
        session,
      });
      const fencedCodeIds = new Set<string>();
      for (const binding of bindings) {
        const entryPointId = binding.entryPointId;
        const evidence = readiness[binding.nodeId];
        if (
          !entryPointId ||
          evidence?.entryPointId !== entryPointId ||
          evidence.ready !== true ||
          !evidence.currentCodeId ||
          !Number.isSafeInteger(evidence.currentCodeVersion) ||
          fencedCodeIds.has(evidence.currentCodeId)
        ) {
          throw new WhatsAppQrActivationConflictError();
        }

        const codeFence = await WhatsAppQrCode.updateOne(
          {
            workspaceId: params.workspaceId,
            entryPointId,
            codeId: evidence.currentCodeId,
            version: evidence.currentCodeVersion,
            placementBindingState: "CURRENT",
            routingState: "ENABLED",
            providerState: "ACTIVE",
          },
          {
            $set: {
              lastActivationFenceToken: params.activationFenceToken,
            },
            $inc: { version: 1 },
          },
          { session, runValidators: true }
        );
        if (codeFence.matchedCount !== 1) {
          throw new WhatsAppQrActivationConflictError();
        }
        fencedCodeIds.add(evidence.currentCodeId);
      }

      const updatedQuery = Scenario.findOneAndUpdate(
        exactScenarioFilter,
        params.mutation,
        { new: true, session }
      );
      committed = await updatedQuery.lean<Record<string, unknown> | null>({
        defaults: false,
      });
      if (!committed) throw new WhatsAppQrActivationConflictError();
    };
    if (params.session) {
      await commit();
    } else {
      await session.withTransaction(commit);
    }
  } finally {
    if (!params.session) await session.endSession();
  }

  if (!committed) throw new WhatsAppQrActivationConflictError();
  return committed;
}
