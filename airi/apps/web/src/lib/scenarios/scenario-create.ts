import {
  DEFAULT_SCENARIO_VIEWPORT,
  isScenarioViewport,
  normalizeScenarioEntryPolicy,
  normalizeScenarioMatchingRole,
  normalizeScenarioPriority,
  normalizeScenarioStatus,
  normalizeScenarioTimezone,
  readScenarioGraphEnvelope,
  type ScenarioGraphNode,
} from "@icecore/scenario-contracts";
import { readNonEmptyString as normalizeOptionalString } from "@icecore/shared/lib/value-utils";
import {
  BirthdayScenarioConflictError,
  scenarioHasBirthdayBulkSchedule,
  withBirthdayScenarioWriteFence,
} from "@/lib/campaign/campaign-birthday-scenario-guards";
import connectDB from "@/lib/mongoose";
import {
  ensureCompanyConversationCapacity,
  ensureCompanyScenarioCapacity,
} from "@/lib/limits/company-limits";
import {
  normalizeScenarioGraphForPersistence,
  normalizeScenarioModeForPersistence,
} from "@/lib/scenarios/scenario-graph-persistence";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { collectWhatsAppQrTriggerNodeIds } from "@/lib/scenarios/graph-validation";
import { hasNewLegacyActionRoutingAssignments } from "@/lib/scenarios/legacy-action-routing";
import { stripServerOwnedWhatsAppFlowProviderFields } from "@/lib/scenarios/whatsapp-flow-projection";
import { assertOrdinaryScenarioWritePreservesWhatsAppQrBindings } from "@/lib/whatsapp/qr-entry-points/scenario-binding";
import { syncScenarioLinkedConditions } from "@/lib/scenarios/linked-conditions";
import { validateScenarioWriteGraph } from "@/lib/scenarios/scenario-write-validation";
import { serializeCreatedScenarioDetail } from "@/lib/scenarios/scenario-detail";
import { ScenarioOperationError } from "@/lib/scenarios/scenario-operation-error";
import { admitBuilderBirthdayScenarioAudience } from "@/lib/scenarios/scenario-birthday-admission";
import { emitScenarioCreatedUsageBestEffort } from "@/lib/scenarios/scenario-created-usage";
import { Scenario } from "@/models/scenario";
import { Types } from "mongoose";

/** Decode defaults before authorization, retaining the POST adapter's ordering. */
export function prepareScenarioCreate(body: Record<string, unknown>) {
  const name = body.name;
  const description = body.description;
  const status = normalizeScenarioStatus(body.status);
  const timezone = normalizeScenarioTimezone(body.timezone);
  const priority = normalizeScenarioPriority(body.priority);
  const graph = normalizeScenarioGraphForPersistence({
    graphSchemaVersion: body.graphSchemaVersion,
    nodes: body.nodes,
    edges: body.edges,
  });
  const nodes = stripServerOwnedWhatsAppFlowProviderFields(
    graph.nodes as ScenarioGraphNode[]
  );
  const mode = normalizeScenarioModeForPersistence(body.mode, nodes);
  const envelope = readScenarioGraphEnvelope({ nodes, edges: graph.edges });
  if (!envelope)
    throw new ScenarioOperationError({ kind: "graph_payload_invalid" });
  const edges = envelope.edges;
  const presetId = normalizeOptionalString(body.presetId);
  const presetVersion = normalizeOptionalString(body.presetVersion);
  const segmentKey = normalizeOptionalString(body.segmentKey);
  const matchingRole = normalizeScenarioMatchingRole(body.matchingRole);
  const entryPolicy = normalizeScenarioEntryPolicy(body.entryPolicy);
  const viewport = isScenarioViewport(body.viewport)
    ? body.viewport
    : DEFAULT_SCENARIO_VIEWPORT;

  return {
    name,
    description,
    status,
    timezone,
    priority,
    graphSchemaVersion: graph.graphSchemaVersion,
    nodes,
    mode,
    edges,
    presetId,
    presetVersion,
    segmentKey,
    matchingRole,
    entryPolicy,
    viewport,
  };
}

export async function createScenario(
  actor: { workspaceId: string; userId: string },
  command: ReturnType<typeof prepareScenarioCreate>
) {
  const { workspaceId, userId } = actor;
  const {
    name,
    description,
    status,
    timezone,
    priority,
    graphSchemaVersion,
    nodes,
    mode,
    edges,
    presetId,
    presetVersion,
    segmentKey,
    matchingRole,
    entryPolicy,
    viewport,
  } = command;
  const capacity = await ensureCompanyConversationCapacity(
    supabaseAdmin,
    workspaceId
  );
  if (!capacity.allowed) {
    throw new ScenarioOperationError({
      kind: "conversation_capacity",
      limit: capacity.limit,
    });
  }

  const scenarioCapacity = await ensureCompanyScenarioCapacity(
    supabaseAdmin,
    workspaceId
  );
  if (!scenarioCapacity.allowed) {
    throw new ScenarioOperationError({
      kind: "scenario_capacity",
      limit: scenarioCapacity.limit,
    });
  }

  if (
    hasNewLegacyActionRoutingAssignments({
      previousNodes: [],
      previousEdges: [],
      nextNodes: nodes,
      nextEdges: edges,
    })
  ) {
    throw new ScenarioOperationError({ kind: "legacy_assignment_forbidden" });
  }

  await connectDB();

  const createdScenarioId = new Types.ObjectId();
  const qrBindingWrite = assertOrdinaryScenarioWritePreservesWhatsAppQrBindings(
    {
      previousNodes: [],
      nextNodes: nodes as Array<{
        id: string;
        data: import("@icecore/scenario-contracts").ScenarioNodeData;
      }>,
    }
  );
  if (!qrBindingWrite.ok) {
    throw new ScenarioOperationError({
      kind: "qr_binding_changed",
      code: qrBindingWrite.code,
      nodeId: qrBindingWrite.nodeId,
      change: qrBindingWrite.change,
    });
  }
  const whatsappQrNodeIds = collectWhatsAppQrTriggerNodeIds(
    (
      nodes as Array<{
        id?: string;
        data?: import("@icecore/scenario-contracts").ScenarioNodeData;
      }>
    ).flatMap(node => {
      if (!node.id || !node.data) return [];
      return [{ id: String(node.id), data: node.data }];
    })
  );
  // QR placements cannot be ready before the scenario exists. Persist a
  // requested active QR scenario as a draft, then let the existing PATCH
  // activation path validate the provisioned entry-point rows. A builder
  // birthday root the save would schedule (daily WhatsApp or Telegram) arms
  // only through that save, which runs the birthday guard and the schedule
  // reconcile.
  const hasBuilderBirthdayRoot =
    mode !== "bulk_campaign" &&
    scenarioHasBirthdayBulkSchedule({ mode, nodes, edges });
  const effectiveStatus =
    status === "active" &&
    (whatsappQrNodeIds.length > 0 || hasBuilderBirthdayRoot)
      ? "draft"
      : status;

  await validateScenarioWriteGraph({
    workspaceId,
    scenarioId: createdScenarioId.toString(),
    nodes,
    edges,
    options: {
      mode: effectiveStatus === "active" ? "runnable" : "draft",
      ...(mode === "bulk_campaign"
        ? { scenarioMode: "bulk_campaign" as const }
        : {}),
    },
  });

  await admitBuilderBirthdayScenarioAudience({
    workspaceId,
    mode,
    status,
    nodes,
    edges,
  });

  const payload = {
    _id: createdScenarioId,
    workspaceId,
    name: typeof name === "string" && name.trim() ? name.trim() : "Scenario",
    description: typeof description === "string" ? description.trim() : "",
    status: effectiveStatus,
    mode,
    timezone,
    priority,
    presetId,
    presetVersion,
    segmentKey,
    matchingRole,
    entryPolicy,
    graphSchemaVersion,
    nodes,
    edges,
    viewport,
    createdBy: userId,
    updatedBy: userId,
  };
  let usedTransactionInsert = false;
  let created;
  try {
    created = await withBirthdayScenarioWriteFence({
      workspaceId,
      scenarioId: createdScenarioId.toString(),
      scenario: payload,
      commit: async session => {
        if (!session) return Scenario.create(payload);
        // insertMany validates/defaults the document without the save hook's
        // premature usage emission. The _id is stable across transaction retries.
        usedTransactionInsert = true;
        const inserted = await Scenario.insertMany([payload], {
          session,
          ordered: true,
        });
        if (!inserted[0])
          throw new Error("Scenario creation did not insert a document.");
        return inserted[0];
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
    throw error;
  }
  if (usedTransactionInsert) emitScenarioCreatedUsageBestEffort(payload);

  await syncScenarioLinkedConditions({
    workspaceId,
    scenarioId: createdScenarioId.toString(),
    scenario: created.toObject() as Record<string, unknown>,
  });

  const createdRecord =
    (await Scenario.findOne({
      _id: createdScenarioId,
      workspaceId,
      deletedAt: null,
    }).lean<Record<string, unknown> | null>({ defaults: false })) ??
    (created.toObject() as Record<string, unknown>);
  return serializeCreatedScenarioDetail({
    workspaceId,
    scenario: createdRecord,
  });
}
