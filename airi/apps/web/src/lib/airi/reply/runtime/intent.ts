import { hasGreetedToday } from "@/lib/airi/conversation";
import { sendAndPersistOutbound } from "@/lib/airi/reply/delivery/outbound-message";
import { resolveIntentPolicy } from "@/lib/airi/reply/intent/intent-policy";
import { generateSafeIntentReply } from "@/lib/airi/reply/generation/safe-intent-reply";
import {
  previewStringArray,
  previewText,
  traceableChain,
} from "@/lib/observability/tracing";
import type { WorkspaceAgentPersona } from "@/lib/airi/agent-context";
import type { AutoReplyDiagnosticsContext } from "@/lib/airi/reply/runtime/context";
import { airiReplyLogger } from "@/lib/airi/reply/runtime/reply-logging";
import { trackTurnUnderstandingMetrics } from "@/lib/airi/reply/runtime/reply-operator-metrics";
import { clearSuppressedStateAfterDelivery } from "@/lib/airi/reply/delivery/temporal-outbound";
import {
  understandCustomerTurn,
  type ScenarioStepAnswerKind,
} from "@/lib/airi/reply/turn/understand-customer-turn";
import { normalizeScenarioSharedLocationPoint } from "@icecore/scenario-contracts";
import { loadThreadReplyContext } from "@/lib/airi/reply/thread/thread-memory";
import type { ThreadReplyContext } from "@/lib/airi/reply/thread/thread-context";
import type { AiriScenarioRuntimeConfig } from "@icecore/airi-runtime/scenario-runtime-types";
import { isSameLanguage } from "@/lib/airi/shared/language-utils";
import type { WorkspaceBotRuntimeSettings } from "@/lib/airi/workspace-bot-contract";
import type { ConversationDocument } from "@/types/models";
import { NextResponse } from "next/server";
import type { AiriAutoReplyParams } from "@icecore/airi-runtime/auto-reply";
import { runAutoReplyStage } from "./context";

type DeliveryDecision = {
  allowSend: boolean;
  reason?: string | null;
  rolloutBucket?: number | null;
  rolloutPercentage?: number | null;
};

type RunIntentFastPathParams = {
  autoReplyParams: AiriAutoReplyParams;
  diagnostics: AutoReplyDiagnosticsContext;
  workspaceId: string;
  conversation: ConversationDocument;
  effectiveInputText: string;
  customerReplyLanguage: string;
  scenarioRuntime: AiriScenarioRuntimeConfig | null;
  workspaceBotSettings: Pick<
    WorkspaceBotRuntimeSettings,
    | "retrievalQueryMode"
    | "includeRecentConversationInRetrievalContext"
    | "elevenlabsAgentId"
    | "agentPersona"
    | "channelInstructions"
  >;
  conversationPreferredLanguage?: string | null;
  workspaceLanguage?: string | null;
  evaluateDelivery: () => DeliveryDecision;
  checkPoint: (label: string) => Promise<boolean>;
  stopTyping: () => void;
};

type IntentFastPathResult = {
  threadReplyContext: ThreadReplyContext;
  customerReplyLanguage: string;
  handledResponse?: NextResponse;
  alreadyGreetedToday?: boolean;
};

/**
 * Within a running scenario step, a shared location or a picked option is
 * the customer's answer to that step's question.
 */
export function readScenarioStepAnswerKind(params: {
  scenarioRuntime: AiriScenarioRuntimeConfig | null;
  newMessage: { whatsappLocation?: unknown } | null | undefined;
  quickReplyPayload?: string | null;
}): ScenarioStepAnswerKind | null {
  if (!params.scenarioRuntime) return null;
  if (normalizeScenarioSharedLocationPoint(params.newMessage?.whatsappLocation))
    return "location";
  return params.quickReplyPayload?.trim() ? "choice" : null;
}

async function runIntentFastPathImpl(
  params: RunIntentFastPathParams
): Promise<IntentFastPathResult> {
  const {
    autoReplyParams,
    diagnostics,
    workspaceId,
    conversation,
    effectiveInputText,
    scenarioRuntime,
    workspaceBotSettings,
  } = params;

  const threadReplyContext = await runAutoReplyStage({
    label: "load-thread-reply-context",
    diagnostics,
    meta: {
      retrievalQueryMode: workspaceBotSettings.retrievalQueryMode,
      includeRecentConversationInRetrievalContext:
        workspaceBotSettings.includeRecentConversationInRetrievalContext,
    },
    action: () =>
      loadThreadReplyContext({
        conversationId: String(conversation._id),
        latestInboundText: effectiveInputText,
        quickReplyPayload: autoReplyParams.quickReplyPayload,
        scenarioStepAnswer: readScenarioStepAnswerKind({
          scenarioRuntime,
          newMessage: autoReplyParams.newMessage,
          quickReplyPayload: autoReplyParams.quickReplyPayload,
        }),
        mode: workspaceBotSettings.retrievalQueryMode,
        includeHistoryInContext:
          workspaceBotSettings.includeRecentConversationInRetrievalContext,
        conversationPreferredLanguage: params.conversationPreferredLanguage,
        workspaceLanguage: params.workspaceLanguage,
      }),
  });

  let customerReplyLanguage = params.customerReplyLanguage;
  if (
    threadReplyContext.dominantLanguage &&
    (!customerReplyLanguage ||
      isSameLanguage(
        threadReplyContext.dominantLanguage,
        customerReplyLanguage
      ))
  ) {
    customerReplyLanguage = threadReplyContext.dominantLanguage;
  }

  if (scenarioRuntime) {
    const alreadyGreetedToday = await hasGreetedToday(
      String(conversation._id)
    ).catch(() => false);
    airiReplyLogger.info("airi.reply.intent_decision", {
      workspaceId,
      conversationId: String(conversation._id),
      messageId: String(autoReplyParams.newMessage._id),
      channel: autoReplyParams.type,
      outcome: "scenario_first",
      scenarioId: scenarioRuntime.scenarioId,
      hasConversationWindow: Boolean(threadReplyContext.conversationWindow),
      hasUnresolvedNeed: threadReplyContext.hasUnresolvedNeed,
    });
    return {
      threadReplyContext,
      customerReplyLanguage,
      alreadyGreetedToday,
    };
  }

  const turnUnderstanding =
    threadReplyContext.turnUnderstanding ||
    (await understandCustomerTurn(
      effectiveInputText,
      customerReplyLanguage,
      threadReplyContext.conversationWindow || undefined,
      {
        elevenlabsAgentId: workspaceBotSettings.elevenlabsAgentId,
        intentAnchor: threadReplyContext.intentAnchor,
        hasUnresolvedNeed: threadReplyContext.hasUnresolvedNeed,
        currentGoal: threadReplyContext.currentGoal,
        unresolvedNeeds: threadReplyContext.unresolvedNeeds,
        lastGrounding: threadReplyContext.lastGrounding,
        activeSelection: threadReplyContext.activeSelection ?? undefined,
        quickReplyPayload: autoReplyParams.quickReplyPayload,
      }
    ));
  const alreadyGreetedToday = await hasGreetedToday(
    String(conversation._id)
  ).catch(() => false);
  const intentPolicy = resolveIntentPolicy({
    turnUnderstanding,
    threadContext: threadReplyContext,
    language: customerReplyLanguage,
    alreadyGreetedToday,
  });

  const logIntentDecision = (
    outcome:
      | "scenario_first"
      | "proceed_with_rag"
      | "safe_reply_sent"
      | "safe_reply_suppressed"
      | "non_rag_skip",
    extras?: Record<string, unknown>
  ) => {
    airiReplyLogger.info("airi.reply.intent_decision", {
      workspaceId,
      conversationId: String(conversation._id),
      messageId: String(autoReplyParams.newMessage._id),
      channel: autoReplyParams.type,
      outcome,
      turnKind: turnUnderstanding.kind,
      confidence: turnUnderstanding.confidence,
      proceedWithRag: outcome === "proceed_with_rag",
      hasConversationWindow: Boolean(threadReplyContext.conversationWindow),
      followUpMode: turnUnderstanding.followUpMode,
      planningSource: turnUnderstanding.planningSource,
      hasUnresolvedNeed: threadReplyContext.hasUnresolvedNeed,
      safeReplyKey: turnUnderstanding.safeReplyKey,
      ...extras,
    });
  };

  const recordTurnMetrics = (safeReplySent: boolean) => {
    trackTurnUnderstandingMetrics({
      workspaceId,
      conversationId: String(conversation._id),
      channel: autoReplyParams.type,
      turnKind: turnUnderstanding.kind,
      confidence: turnUnderstanding.confidence,
      proceedWithRag: intentPolicy.proceedWithRag,
      hasConversationWindow: Boolean(threadReplyContext.conversationWindow),
      safeReplySent,
    });
  };

  if (intentPolicy.proceedWithRag) {
    recordTurnMetrics(false);
    logIntentDecision("proceed_with_rag", {
      dependsOnPriorContext: turnUnderstanding.dependsOnPriorContext,
      intentAnchor: threadReplyContext.intentAnchor.slice(0, 80),
      safeReplySent: false,
    });
    return { threadReplyContext, customerReplyLanguage, alreadyGreetedToday };
  }

  if (intentPolicy.safeReplyType) {
    const intentDeliveryGate = params.evaluateDelivery();
    const safeReplySent = intentDeliveryGate.allowSend;

    logIntentDecision(
      safeReplySent ? "safe_reply_sent" : "safe_reply_suppressed",
      {
        dependsOnPriorContext: turnUnderstanding.dependsOnPriorContext,
        intentAnchor: threadReplyContext.intentAnchor.slice(0, 80),
        safeReplySent,
        reason: intentDeliveryGate.reason,
        rolloutBucket: intentDeliveryGate.rolloutBucket,
        rolloutPercentage: intentDeliveryGate.rolloutPercentage,
      }
    );

    if (!intentDeliveryGate.allowSend) {
      recordTurnMetrics(false);
      params.stopTyping();
      return {
        threadReplyContext,
        customerReplyLanguage,
        handledResponse: NextResponse.json({
          status: "ok",
          turn_kind: turnUnderstanding.kind,
          skipped_delivery_reason: intentDeliveryGate.reason,
        }),
      };
    }

    if (!(await params.checkPoint("Pre-Intent-Reply"))) {
      recordTurnMetrics(false);
      return {
        threadReplyContext,
        customerReplyLanguage,
        handledResponse: NextResponse.json({ status: "ok", cancelled: true }),
      };
    }

    const persona: WorkspaceAgentPersona | undefined =
      workspaceBotSettings.agentPersona;
    const safeReplyText = generateSafeIntentReply({
      type: intentPolicy.safeReplyType,
      language: customerReplyLanguage,
      alreadyGreetedToday,
    });

    if (safeReplyText) {
      const displayName = persona?.displayName || "Airi";
      await sendAndPersistOutbound({
        ...autoReplyParams,
        content: `${displayName}: ${safeReplyText}`,
      });
      await clearSuppressedStateAfterDelivery(String(conversation._id)).catch(
        error => {
          airiReplyLogger.warn("airi.reply.intent_decision", {
            conversationId: String(conversation._id),
            note: "clear_suppression_state_after_safe_reply_failed",
            errorMessage:
              error instanceof Error ? error.message : String(error),
          });
        }
      );
    }
    recordTurnMetrics(true);

    params.stopTyping();
    return {
      threadReplyContext,
      customerReplyLanguage,
      handledResponse: NextResponse.json({
        status: "ok",
        turn_kind: turnUnderstanding.kind,
      }),
    };
  }

  recordTurnMetrics(false);
  logIntentDecision("non_rag_skip", {
    dependsOnPriorContext: turnUnderstanding.dependsOnPriorContext,
    intentAnchor: threadReplyContext.intentAnchor.slice(0, 80),
    safeReplySent: false,
  });
  params.stopTyping();
  return {
    threadReplyContext,
    customerReplyLanguage,
    handledResponse: NextResponse.json({
      status: "ok",
      turn_kind: turnUnderstanding.kind,
      skipped_non_rag: true,
    }),
  };
}

export const runIntentFastPath = traceableChain(runIntentFastPathImpl, {
  name: "airi.reply.intent_fast_path",
  tags: ["airi", "reply", "intent"],
  getMetadata: params => ({
    workspace_id: params.workspaceId,
    conversation_id: String(params.conversation._id),
    message_id: String(params.autoReplyParams.newMessage._id),
    channel: params.autoReplyParams.type,
    scenario_id: params.scenarioRuntime?.scenarioId || null,
    preferred_language: params.customerReplyLanguage,
  }),
  processInputs: inputs => {
    const payload = (
      "input" in inputs ? inputs.input : inputs
    ) as RunIntentFastPathParams;
    return {
      workspace_id: payload.workspaceId,
      conversation_id: String(payload.conversation._id),
      message_preview: previewText(payload.effectiveInputText, 240),
      customer_reply_language: payload.customerReplyLanguage,
      scenario_id: payload.scenarioRuntime?.scenarioId || null,
      retrieval_query_mode: payload.workspaceBotSettings.retrievalQueryMode,
      include_recent_conversation_in_retrieval_context:
        payload.workspaceBotSettings
          .includeRecentConversationInRetrievalContext,
    };
  },
  processOutputs: outputs => {
    const result = (
      "outputs" in outputs ? outputs.outputs : outputs
    ) as IntentFastPathResult;
    return {
      customer_reply_language: result.customerReplyLanguage,
      handled_response: Boolean(result.handledResponse),
      already_greeted_today: result.alreadyGreetedToday ?? null,
      dominant_language: result.threadReplyContext.dominantLanguage || null,
      current_goal_preview: previewText(
        result.threadReplyContext.currentGoal,
        160
      ),
      open_asks: previewStringArray(
        result.threadReplyContext.openAsks || [],
        4,
        100
      ),
      turn_kind: result.threadReplyContext.turnUnderstanding?.kind || null,
      follow_up_mode:
        result.threadReplyContext.turnUnderstanding?.followUpMode || "none",
    };
  },
});
