import "server-only";

import type { AiriTurnContextInput } from "@/lib/temporal/airi-turn-context";
import type { ICreativeAsset } from "@/models/creative-asset";
import type {
  AiriScenarioTimerDependencies,
  TimerConversationRecord,
  ScenarioRecord,
} from "@icecore/airi-runtime/temporal-scenario-timers";
import type { Channel, ConversationDocument } from "@/types/models";
import type { ScenarioOutboundCheckpoint } from "@icecore/airi-runtime/scenario-state";
import { resolveConversationScenariosEnabled } from "@/lib/airi/workspace-bot-contract";
import { findLatestInboundSharedLocation } from "@/lib/business-locations/inbound-location-query";
import connectDB from "@/lib/mongoose";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import { Scenario } from "@/models/scenario";
import { normalizeVideoGenerationCompletionTarget } from "@icecore/temporal";
import { asNullableRecord } from "@icecore/shared/lib/value-utils";

/** The web host also supplies these services to Temporal activities. */
export const airiScenarioTimerDependencies: AiriScenarioTimerDependencies = {
  connectDB,
  handleConfirmedPaymentEvent: async event => {
    const { handleConfirmedPaymentScenarioEvent } = await import(
      "@/lib/conversions/confirmed-payment-runtime"
    );
    return handleConfirmedPaymentScenarioEvent(event);
  },
  loadConversation: conversationId =>
    Conversation.findById(conversationId)
      .select(
        "workspaceId channel sourceId chat user business_connection_id preferred_language updatedAt external_thread airi_context_memory airi_scenario_state airi_handoff_active airi_handoff_source airi_handoff_reason airi_handoff_started_at airi_scenarios_enabled airi_bot_enabled airi_enabled"
      )
      .lean<TimerConversationRecord | null>(),
  // Same inputs the reply runtime gates timer turns on.
  resolveScenariosEnabled: async conversation => {
    const { getWorkspaceScenariosDefault } = await import(
      "@/lib/airi/workspace-bot-default"
    );
    const workspaceId = String(conversation.workspaceId || "");
    return resolveConversationScenariosEnabled(
      conversation,
      workspaceId ? await getWorkspaceScenariosDefault(workspaceId) : undefined
    );
  },
  loadScenario: ({ workspaceId, scenarioId }) =>
    Scenario.findOne({
      _id: scenarioId,
      workspaceId,
      status: "active",
      deletedAt: null,
    })
      .select("_id name nodes edges updatedAt")
      .lean<ScenarioRecord | null>(),
  findLatestMessageAfter: ({ conversationId, after }) =>
    Message.findOne({ conversation: conversationId, date: { $gt: after } })
      .sort({ date: -1 })
      .select("date")
      .lean<{ date?: Date | string | null } | null>(),
  // A shared location's text is a place name or address, never the
  // customer's words, so it can't end a wait as a stop word.
  findTextMessagesAfter: ({ conversationId, after, limit }) =>
    Message.find({
      conversation: conversationId,
      date: { $gt: after },
      text: { $exists: true, $ne: "" },
      "whatsappLocation.latitude": { $not: { $type: "number" } },
    })
      .sort({ date: -1 })
      .limit(limit)
      .select("text")
      .lean<Array<{ text?: unknown }>>(),
  findLatestInboundLocation: findLatestInboundSharedLocation,
  findPendingOutbound: ({
    messageId,
    workspaceId,
    conversationId,
    scenarioId,
    sourceActionNodeId,
  }) =>
    Message.findOne({
      _id: messageId,
      workspaceId,
      conversation: conversationId,
      direction: "outbound",
      "origin.scenarioId": scenarioId,
      "origin.nodeId": sourceActionNodeId,
    })
      .select(
        "channel messageId temporalDispatch.state delivery.status delivery.failedAt"
      )
      .lean<ScenarioOutboundCheckpoint | null>(),
  completeLockedScenarioAndPersist: async input => {
    const state = await import(
      "@/lib/airi/reply/runtime/auto-reply-scenario-state"
    );
    return state.completeLockedScenarioAndPersist(input);
  },
  buildTimerTurnSignal: async ({
    timer,
    conversation,
    channel,
    messageId,
    followUpInstruction,
  }) => {
    const { resolveChatDocument, buildChannelSpecificParams } = await import(
      "@/lib/airi/scenario/scenario-channel-utils"
    );
    const timerConversation = conversation as ConversationDocument;
    const { chatDocument, chatId, chatType } =
      await resolveChatDocument(timerConversation);
    const channelParams = await buildChannelSpecificParams({
      workspaceId: timer.workspaceId,
      conversation: timerConversation,
      chatDocument,
      channelOverride: channel,
    });
    if (!channelParams.ok) return null;
    const newMessage = {
      _id: messageId,
      text: "",
      date: new Date(),
      conversation: conversation._id,
      direction: "inbound",
      channel,
    };
    const params: AiriTurnContextInput = {
      type: channel as Channel,
      workspaceId: timer.workspaceId,
      conversation: timerConversation,
      chatDocument,
      chatId,
      chatType,
      botToken: channelParams.botToken,
      whatsAppInfo: channelParams.whatsAppInfo,
      instagramInfo: channelParams.instagramInfo,
      newMessage,
      scenarioOverrideId: timer.scenarioId,
      proactiveTrigger: true,
      triggerEventKind: "no_human_reply_timeout",
      followUpInstruction: followUpInstruction || undefined,
    };
    const {
      createAiriConversationTurnContext,
      buildAiriConversationTurnSignalFromContext,
    } = await import("@/lib/temporal/airi-turn-context");
    const context = await createAiriConversationTurnContext(params);
    return buildAiriConversationTurnSignalFromContext({
      autoReplyParams: params,
      turnContextId: context.turnContextId,
    });
  },
  generativeAIResult: {
    readOwner: async input => {
      const store = await import(
        "@/lib/airi/reply/runtime/generative-ai-execution-store"
      );
      return store.readGenerativeExecutionOwnerRecord(input);
    },
    loadAsset: async ({ workspaceId, assetId }) => {
      const { CreativeAsset } = await import("@/models/creative-asset");
      const raw = await CreativeAsset.findOne({
        _id: assetId,
        workspaceId,
      }).lean<ICreativeAsset | null>();
      if (!raw || (raw.kind !== "video" && raw.kind !== "image")) return null;
      const imageScenario =
        raw.kind === "image"
          ? asNullableRecord(asNullableRecord(raw.providerPayload)?.scenario)
          : null;
      let imageCompletionTarget = null;
      try {
        imageCompletionTarget = imageScenario
          ? normalizeVideoGenerationCompletionTarget(
              imageScenario.completionTarget
            )
          : null;
      } catch {
        return null;
      }
      return {
        id: String(raw._id),
        workspaceId: String(raw.workspaceId),
        kind: raw.kind,
        status: raw.status,
        storageProvider: raw.storageProvider || null,
        bucket: raw.bucket || null,
        path: raw.path || null,
        mimeType: raw.mimeType || null,
        fileName: raw.fileName || null,
        fileSize: typeof raw.fileSize === "number" ? raw.fileSize : null,
        videoWorkflowId:
          raw.kind === "image"
            ? typeof imageScenario?.workflowId === "string"
              ? imageScenario.workflowId
              : null
            : raw.generation?.orchestration?.workflowId || null,
        attemptToken:
          raw.kind === "image"
            ? typeof imageScenario?.attemptToken === "string"
              ? imageScenario.attemptToken
              : null
            : raw.generation?.submission?.attemptToken || null,
        completionTarget:
          raw.kind === "image"
            ? imageCompletionTarget
            : raw.generation?.orchestration?.completionTarget || null,
      };
    },
    hydrateOriginalInbound: async input => {
      const context = await import("@/lib/temporal/airi-turn-context");
      return context.hydrateStoredAiriAutoReplyParamsFromTurn(input);
    },
    // The language signals a turn reads: the reply that started the
    // generation, the customer's recent language and the stored preference.
    resolveCustomerLanguage: async body => {
      const { resolveCustomerReplyLanguage } = await import(
        "@/lib/airi/reply/generation/reply-language"
      );
      const conversation = asNullableRecord(body.conversation);
      const inbound = asNullableRecord(body.newMessage);
      const read = (value: unknown) =>
        typeof value === "string" ? value : null;
      return resolveCustomerReplyLanguage({
        latestInboundText: read(inbound?.text),
        recentCustomerLanguage: read(conversation?.airi_last_customer_language),
        conversationPreferredLanguage: read(conversation?.preferred_language),
      });
    },
    captureOutbound: async input => {
      const temporalOutbound = await import(
        "@/lib/airi/reply/delivery/temporal-outbound"
      );
      const outbound = await import(
        "@/lib/airi/reply/delivery/outbound-message"
      );
      const captured = await temporalOutbound.runWithTemporalOutboundCapture({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        capturePostDeliveryEffects: true,
        run: () =>
          outbound.sendAndPersistOutbound(
            input.context as Parameters<
              typeof outbound.sendAndPersistOutbound
            >[0]
          ),
      });
      if (!captured.pendingDelivery)
        throw new Error(
          "Generative result did not reserve an outbound delivery"
        );
      return captured.pendingDelivery;
    },
    claimDelivery: async input => {
      const store = await import(
        "@/lib/airi/reply/runtime/generative-ai-execution-store"
      );
      return store.claimGenerativeDelivery(input);
    },
    nowIso: () => new Date().toISOString(),
  },
};
