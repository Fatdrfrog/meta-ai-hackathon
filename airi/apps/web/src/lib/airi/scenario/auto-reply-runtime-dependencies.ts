import "server-only";
import type { CompanyRuntimeLane } from "@icecore/shared/lib/company-runtime-capacity";
import { readDefaultExport } from "@icecore/airi-runtime/module-interop";

// The worker activity reaches web code only through this host module.
export {
  AIChatProviderAggregateError,
  isRetryableAIProviderError,
} from "@/lib/ai/provider-errors";

export async function withWorkspaceRuntimeCapacity<T>(
  workspaceId: string,
  lane: CompanyRuntimeLane,
  run: (companyId: string) => Promise<T>
): Promise<T> {
  const capacity = readDefaultExport<
    typeof import("@/lib/limits/company-runtime-capacity")
  >(await import("@/lib/limits/company-runtime-capacity"));
  return capacity.withWorkspaceRuntimeCapacity(workspaceId, lane, run);
}
import { findWhatsAppContextMessage } from "@icecore/shared/lib/whatsapp/message-id";
import {
  listScenarioActionFormFieldSchemas,
  listScenarioFormFieldSchemas,
  readScenarioActionFormForFlow,
  resolveSendableWhatsAppFlowProviderId,
  type ScenarioFormFieldSchema,
  type WhatsAppFlowConfig,
} from "@icecore/scenario-contracts";
import { withWorkspaceTextAiAction } from "@/lib/ai/workspace-ai-policy";
import { airiOrchestrationLogger } from "@/lib/airi/reply/runtime/reply-logging";
import { isMongoObjectIdString } from "@/lib/scenarios/task-utils";
import Message from "@/models/message";
import { Scenario } from "@/models/scenario";
import type { AiriTurnExecutionStore } from "@icecore/airi-runtime";
import {
  isScenarioOutboundCheckpointConfirmed,
  type ScenarioOutboundCheckpoint,
} from "@icecore/airi-runtime/scenario-state";
import {
  claimAiriTurnPreparation,
  completeAiriTurnPreparation,
  failAiriTurnPreparation,
  recordAiriConversationTurnDisposition,
} from "@/lib/temporal/airi-turn-execution";

import {
  withPromptInputStateDurability,
  type ScenarioRuntimeDependencies,
  type SubmittedScenarioFormSource,
} from "@icecore/airi-runtime/scenario-runtime-dependencies";
import type { ConversationDocument } from "@/types/models";
import { countGenerativeAIStarts } from "../reply/runtime/generative-ai-execution-store";
import { screenGenerativeAICustomerText } from "./generative-ai-customer-text-screen";
import { extractScenarioPromptInputs } from "./scenario-prompt-input-extraction";
import { resolveActiveScenarioRuntime } from "./scenario-runtime";
import { fetchActiveScenarioById } from "./scenario-runtime-resources";
import {
  clearPendingConditionStateAndPersist,
  completeLockedScenarioAndPersist,
  finalizeScenarioResolution,
  persistPendingConditionState,
  persistScenarioFormSubmission,
  persistScenarioState,
  recordScenarioLocationDecisionAndPersist,
} from "../reply/runtime/auto-reply-scenario-state";
import { findLatestInboundSharedLocation } from "@/lib/business-locations/inbound-location-query";
import { loadActiveBusinessLocations } from "@/lib/business-locations/store";
import { isRecord, readTrimmedString } from "@icecore/shared/lib/value-utils";

/** Durable turn ownership shares the existing reply runtime host adapter. */
export const airiTurnExecutionStore: AiriTurnExecutionStore = {
  claimAiriTurnPreparation,
  completeAiriTurnPreparation,
  failAiriTurnPreparation,
  recordAiriConversationTurnDisposition,
};

/** The parts of an outbound message that tell which form it sent. */
type StoredFormOutbound = {
  origin?: { scenarioId?: unknown; nodeId?: unknown } | null;
  whatsappFlow?: {
    flowId?: unknown;
    scenarioId?: unknown;
    actionNodeId?: unknown;
    responseFieldMetadata?: unknown;
  } | null;
  whatsappServiceMessage?: unknown;
};

const STORED_FORM_OUTBOUND_SELECT =
  "origin whatsappFlow whatsappServiceMessage";

/**
 * Field snapshots a template's Flow send stores. Sends made before field
 * types were stored carry none.
 */
function readStoredFlowFields(value: unknown): ScenarioFormFieldSchema[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(field =>
    isRecord(field) && typeof field.id === "string"
      ? [
          {
            id: field.id,
            label: typeof field.label === "string" ? field.label : null,
            options: Array.isArray(field.options) ? field.options : null,
            ...(typeof field.fieldType === "string"
              ? { fieldType: field.fieldType }
              : {}),
          },
        ]
      : []
  );
}

/**
 * The scenario step an outbound message came from, and the form's fields as
 * the message stored them: a service message keeps its whole form, a
 * template's Flow send keeps field snapshots. Null for a message no scenario
 * sent, or whose Flow names another step than its origin.
 */
function readSentScenarioForm(
  outbound: StoredFormOutbound | null | undefined
): SubmittedScenarioFormSource | null {
  const scenarioId = readTrimmedString(outbound?.origin?.scenarioId);
  const sourceActionNodeId = readTrimmedString(outbound?.origin?.nodeId);
  if (!outbound || !scenarioId || !sourceActionNodeId) return null;
  const flow = outbound.whatsappFlow;
  const flowScenarioId = readTrimmedString(flow?.scenarioId);
  const flowNodeId = readTrimmedString(flow?.actionNodeId);
  if (
    (flowScenarioId && flowScenarioId !== scenarioId) ||
    (flowNodeId && flowNodeId !== sourceActionNodeId)
  ) {
    return null;
  }
  const command =
    isRecord(outbound.whatsappServiceMessage) &&
    isRecord(outbound.whatsappServiceMessage.command)
      ? outbound.whatsappServiceMessage.command
      : null;
  const sentFlowConfig =
    command?.kind === "flow" && isRecord(command.flowConfig)
      ? command.flowConfig
      : null;
  const fields = sentFlowConfig
    ? listScenarioFormFieldSchemas(sentFlowConfig)
    : readStoredFlowFields(flow?.responseFieldMetadata);
  return {
    scenarioId,
    sourceActionNodeId,
    flowId:
      readTrimmedString(flow?.flowId) ||
      (sentFlowConfig
        ? resolveSendableWhatsAppFlowProviderId({
            flowConfig: sentFlowConfig as WhatsAppFlowConfig,
          })
        : null) ||
      null,
    fields: fields.length > 0 ? fields : null,
  };
}

/**
 * A form's fields from its step in the scenario, for sends that stored none:
 * its Flow config's, else the form saved from the Flow its button opens. A
 * saved form of another Flow than the send's describes another form.
 */
async function readScenarioNodeFormFields(params: {
  workspaceId: string;
  scenarioId: string;
  nodeId: string;
  flowId: string | null;
}): Promise<ScenarioFormFieldSchema[] | null> {
  if (!isMongoObjectIdString(params.scenarioId)) return null;
  const scenario = await Scenario.findOne({
    _id: params.scenarioId,
    workspaceId: params.workspaceId,
  })
    .select("nodes")
    .lean<{ nodes?: unknown } | null>();
  const node = Array.isArray(scenario?.nodes)
    ? scenario.nodes.find(
        (candidate: unknown) =>
          isRecord(candidate) && candidate.id === params.nodeId
      )
    : null;
  const fields = listScenarioActionFormFieldSchemas(
    readScenarioActionFormForFlow(
      isRecord(node) ? node.data : null,
      params.flowId
    )
  );
  return fields.length > 0 ? fields : null;
}

/** Shared web services supplied to each reply invocation by its host. */
export const scenarioRuntimeDependencies: ScenarioRuntimeDependencies<ConversationDocument> =
  {
    runTextAiAction: withWorkspaceTextAiAction,
    async loadBehaviorTemplateValues(scope) {
      const { findOutboundBehaviorRun } = await import(
        "@/lib/scenarios/behavior-delivery"
      );
      const run = await findOutboundBehaviorRun({
        ...scope,
        behaviorRunId: scope.behaviorRunId || undefined,
      });
      if (!run) return {};
      const { websiteCartTemplateValues } = await import(
        "@/lib/commerce/cart-journeys"
      );
      return websiteCartTemplateValues(run);
    },
    loadActiveScenarioSnapshot: fetchActiveScenarioById,
    resolveActiveScenarioRuntime,
    clearPendingConditionStateAndPersist,
    completeLockedScenarioAndPersist,
    finalizeScenarioResolution,
    // Bulk sends record origin.kind "campaign" and the runtime records
    // "scenario"; both identify the action through scenarioId and nodeId.
    async findLatestScenarioActionOutbound({
      workspaceId,
      conversationId,
      scenarioId,
      actionNodeId,
      outboundMessageId,
    }) {
      const outbound = await Message.findOne({
        ...(outboundMessageId ? { _id: outboundMessageId } : {}),
        workspaceId,
        conversation: conversationId,
        direction: "outbound",
        "origin.scenarioId": scenarioId,
        "origin.nodeId": actionNodeId,
      })
        .sort({ date: -1 })
        .select(
          "_id channel messageId temporalDispatch.state delivery.status delivery.failedAt"
        )
        .lean<({ _id?: unknown } & ScenarioOutboundCheckpoint) | null>();
      if (!isScenarioOutboundCheckpointConfirmed(outbound)) return null;
      const outboundId =
        outbound?._id === null || outbound?._id === undefined
          ? ""
          : String(outbound._id).trim();
      return outboundId || null;
    },
    async findTappedScenarioServiceMessage({
      workspaceId,
      conversationId,
      contextMessageId,
      actionNodeId,
    }) {
      type StoredOutbound = {
        origin?: { scenarioId?: unknown; nodeId?: unknown } | null;
        whatsappServiceMessage?: unknown;
      };
      const read = (outbound: StoredOutbound | null) => {
        const origin = outbound?.origin;
        const scenarioId =
          typeof origin?.scenarioId === "string"
            ? origin.scenarioId.trim()
            : "";
        return scenarioId &&
          origin?.nodeId === actionNodeId &&
          outbound?.whatsappServiceMessage
          ? {
              scenarioId,
              whatsappServiceMessage: outbound.whatsappServiceMessage,
            }
          : null;
      };
      const select = "origin whatsappServiceMessage";
      const cited = read(
        await findWhatsAppContextMessage<StoredOutbound>({
          Message,
          conversationId,
          contextMessageId,
          direction: "outbound",
          select,
        })
      );
      if (cited) return cited;
      return read(
        await Message.findOne({
          workspaceId,
          conversation: conversationId,
          direction: "outbound",
          "origin.nodeId": actionNodeId,
          whatsappServiceMessage: { $ne: null },
        })
          .sort({ date: -1 })
          .select(select)
          .lean<StoredOutbound | null>()
      );
    },
    async findSubmittedScenarioForm({
      workspaceId,
      conversationId,
      contextMessageId,
      flowToken,
    }) {
      let sent = readSentScenarioForm(
        await findWhatsAppContextMessage<StoredFormOutbound>({
          Message,
          conversationId,
          contextMessageId,
          direction: "outbound",
          select: STORED_FORM_OUTBOUND_SELECT,
        })
      );
      if (!sent && flowToken) {
        // Without a cited message, the latest send of the same token.
        const [latest, earlier] = await Message.find({
          workspaceId,
          conversation: conversationId,
          direction: "outbound",
          $or: [
            { "whatsappFlow.flowToken": flowToken },
            { "whatsappServiceMessage.command.flowToken": flowToken },
          ],
        })
          .sort({ date: -1 })
          .limit(2)
          .select(STORED_FORM_OUTBOUND_SELECT)
          .lean<StoredFormOutbound[]>();
        sent = readSentScenarioForm(latest);
        const other = readSentScenarioForm(earlier);
        // A data-endpoint form's token repeats wherever the same form is sent.
        if (
          sent &&
          other &&
          (other.scenarioId !== sent.scenarioId ||
            other.sourceActionNodeId !== sent.sourceActionNodeId)
        ) {
          airiOrchestrationLogger.warn(
            "airi.orchestration.scenario_form_flow_token_ambiguous",
            {
              workspaceId,
              conversationId,
              scenarioId: sent.scenarioId,
              sourceActionNodeId: sent.sourceActionNodeId,
              otherScenarioId: other.scenarioId,
              otherSourceActionNodeId: other.sourceActionNodeId,
            }
          );
        }
      }
      if (!sent) return null;
      return {
        ...sent,
        fields:
          sent.fields ??
          (await readScenarioNodeFormFields({
            workspaceId,
            scenarioId: sent.scenarioId,
            nodeId: sent.sourceActionNodeId,
            flowId: sent.flowId,
          })),
      };
    },
    findLatestInboundLocation: findLatestInboundSharedLocation,
    loadBusinessLocations: ({ workspaceId }) =>
      loadActiveBusinessLocations(workspaceId),
    recordScenarioLocationDecision: recordScenarioLocationDecisionAndPersist,
    persistScenarioFormSubmission,
    persistPendingConditionState,
    persistScenarioState: withPromptInputStateDurability(persistScenarioState),
    extractScenarioPromptInputs,
    screenGenerativeAICustomerText,
    countGenerativeAIStarts,
  };
