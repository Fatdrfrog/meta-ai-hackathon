import {
  normalizeScenarioEntryPolicy,
  normalizeScenarioMatchingRole,
  normalizeScenarioPriority,
} from "@icecore/scenario-contracts";
import { previewScenarioEvaluation } from "@/lib/airi/scenario/scenario-runtime";
import { fetchActiveScenariosForWorkspace } from "@/lib/airi/scenario/scenario-runtime-resources";
import connectDB from "@/lib/mongoose";
import { buildScenarioGraphPayloadValidationError } from "@/lib/scenarios/scenario-http";
import {
  readNonEmptyString as normalizeOptionalString,
  readStringArray,
} from "@icecore/shared/lib/value-utils";
import { normalizeScenarioNodesForPersistence } from "@/lib/scenarios/scenario-graph-persistence";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { isScenarioInboundTriggerEventKind } from "@icecore/scenario-contracts";
import { isConversationChannel, type Channel } from "@/types/models";
import { Types } from "mongoose";
import { NextResponse } from "next/server";
import { requiredFieldResponse } from "@/lib/api/json-body";

export const runtime = "nodejs";

type PreviewEvaluationParams = Parameters<typeof previewScenarioEvaluation>[0];
type PreviewScenariosArray = NonNullable<PreviewEvaluationParams["scenarios"]>;
type PreviewScenarioInput = PreviewScenariosArray[number];

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const workspaceId =
      typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
    const rawChannel =
      typeof body?.channel === "string" ? body.channel.trim() : "";
    const hasExplicitEventKind =
      body !== null &&
      typeof body === "object" &&
      Object.prototype.hasOwnProperty.call(body, "eventKind");
    const eventKind = hasExplicitEventKind
      ? typeof body.eventKind === "string"
        ? body.eventKind.trim()
        : ""
      : "inbound_message";

    if (!workspaceId) return requiredFieldResponse("workspaceId");
    if (!isConversationChannel(rawChannel)) {
      return NextResponse.json(
        { error: "Valid channel is required" },
        { status: 400 }
      );
    }
    if (!isScenarioInboundTriggerEventKind(eventKind)) {
      return NextResponse.json(
        { error: "Valid customer-message event is required" },
        { status: 400 }
      );
    }

    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) {
      return access.response;
    }

    await connectDB();

    const activeScenarios = await fetchActiveScenariosForWorkspace({
      workspaceId,
    });

    const draftScenario = body?.draftScenario;
    const mergedScenarios: PreviewScenariosArray = [
      ...(activeScenarios as PreviewScenariosArray),
    ];
    if (draftScenario !== undefined && draftScenario !== null) {
      const graphError =
        buildScenarioGraphPayloadValidationError(draftScenario);
      if (graphError) return graphError;

      const scenarioId = normalizeOptionalString(draftScenario.scenarioId);
      const nextDraftScenario = {
        _id: scenarioId ? new Types.ObjectId(scenarioId) : new Types.ObjectId(),
        name:
          typeof draftScenario.name === "string" && draftScenario.name.trim()
            ? draftScenario.name.trim()
            : "Scenario",
        priority: normalizeScenarioPriority(draftScenario.priority),
        matchingRole: normalizeScenarioMatchingRole(draftScenario.matchingRole),
        entryPolicy: normalizeScenarioEntryPolicy(draftScenario.entryPolicy),
        nodes: normalizeScenarioNodesForPersistence(draftScenario.nodes),
        edges: Array.isArray(draftScenario.edges) ? draftScenario.edges : [],
        updatedAt: new Date(),
      } as PreviewScenarioInput;

      const existingIndex = scenarioId
        ? mergedScenarios.findIndex(
            scenario => String(scenario._id || "") === scenarioId
          )
        : -1;
      if (existingIndex >= 0) {
        mergedScenarios.splice(existingIndex, 1, nextDraftScenario);
      } else {
        mergedScenarios.push(nextDraftScenario);
      }
    }

    const now = new Date();
    const rawInternalLabels = readStringArray(body?.internalLabels);
    const funnelStage = normalizeOptionalString(body?.funnelStage);
    const stageLabel = funnelStage ? `stage:${funnelStage}` : null;
    const internalLabels = stageLabel
      ? Array.from(new Set([...rawInternalLabels, stageLabel]))
      : rawInternalLabels;
    const hasPurchaseHistory = body?.hasPurchaseHistory === true;
    const syntheticConversation = {
      _id: new Types.ObjectId(),
      workspaceId,
      status: "open",
      channel: rawChannel,
      chat: {
        _id: "preview-customer",
        type: "private",
      },
      internal_labels: internalLabels,
      classification: {
        category: normalizeOptionalString(body?.classificationCategory),
      },
      estimated_customer_ltv: hasPurchaseHistory ? 1 : 0,
      revenue_attribution_id: hasPurchaseHistory ? "preview" : null,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
      messages: [],
    } as unknown as import("@/types/models").ConversationDocument;

    const preview = await previewScenarioEvaluation({
      workspaceId,
      conversation: syntheticConversation,
      channel: rawChannel as Channel,
      eventKind,
      messageText: normalizeOptionalString(body?.messageText) || undefined,
      quickReplyPayload: normalizeOptionalString(body?.quickReplyPayload),
      whatsAppFlowResponseJson: normalizeOptionalString(
        body?.whatsAppFlowResponseJson
      ),
      triggerLanguage: null,
      isNewCustomer: body?.isNewCustomer === true,
      scenarios: mergedScenarios,
      now,
    });

    return NextResponse.json(preview);
  } catch (error) {
    console.error("[Scenarios Preview API] POST error:", error);
    return NextResponse.json(
      { error: "Failed to preview scenarios" },
      { status: 500 }
    );
  }
}
