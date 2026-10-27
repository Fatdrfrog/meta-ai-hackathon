import type { WhatsAppReferralFields } from "@icecore/whatsapp/referralFields";
import { getCompiledScenarioGraph } from "./scenario-graph";
import {
  normalizeConversationScenarioState,
  type ConversationScenarioState,
} from "./scenario-state";
import { resolvePendingPostActionWait } from "./temporal-scenario-timers/graph/post-action";
import type { ConfirmedPaymentScenarioSnapshot } from "@icecore/shared/types/conversion-events";
import { resolveConversationReplySourceId } from "@icecore/shared/lib/conversation-reply-source";
import {
  isScenarioStateLocked,
  isScenarioPendingWriteCoordinationError,
  type GenerativeAICustomerTextPart,
  type KeptScenarioPendingWait,
  type ScenarioRuntimeDependencies,
} from "./scenario-runtime-dependencies";
import {
  getNoReplyAnswerMatchRules,
  getPostActionAnswerMatchHandleId,
  postActionConditionUsesAnswerMatchRules,
  hasBlockingScenarioRoutingDiagnostics,
  isScenarioActionBranchDelayVirtualNodeId,
  isScenarioInteractiveReplyEventKind,
  isScenarioQuickReplyEventKind,
} from "@icecore/scenario-contracts";
import * as coachUtilsServerModule from "@/lib/airi/coach/coach-utils-server";
import * as interactiveNoReplyModule from "@/lib/airi/interactive-no-reply";
import * as suggestionPayloadsModule from "@/lib/airi/ops/suggestion-payloads";
import * as postActionAnswerMatchingModule from "@/lib/airi/post-action-answer-matching";
import * as knowledgeGapTrackerModule from "@/lib/airi/rag/knowledge/knowledge-gap-tracker";
import * as outboundMessageModule from "@/lib/airi/reply/delivery/outbound-message";
import * as deliveryGateModule from "@/lib/airi/reply/delivery/reply-delivery-gate";
import * as replyRichTextFormatModule from "@/lib/airi/reply/delivery/reply-rich-text-format";
import * as temporalOutboundModule from "@/lib/airi/reply/delivery/temporal-outbound";
import * as replyLanguageModule from "@/lib/airi/reply/generation/reply-language";
import * as replySafetyModule from "@/lib/airi/reply/generation/reply-safety";
import * as autoReplyExecutionGatesModule from "@/lib/airi/reply/runtime/auto-reply-execution-gates";
import * as autoReplyGuardsModule from "@/lib/airi/reply/runtime/auto-reply-guards";
import * as autoReplyInputModule from "@/lib/airi/reply/runtime/auto-reply-input";
import * as autoReplyRealtimeModule from "@/lib/airi/reply/runtime/auto-reply-realtime";
import * as generativeAIExecutionStoreModule from "@/lib/airi/reply/runtime/generative-ai-execution-store";
import * as autoReplyTemplateUtilsModule from "@/lib/airi/reply/runtime/auto-reply-template-utils";
import type {
  AutoReplyDiagnosticsContext,
  LeanConversationBotState,
} from "@/lib/airi/reply/runtime/context";
import * as replyContextModule from "@/lib/airi/reply/runtime/context";
import * as dispatchModule from "@/lib/airi/reply/runtime/dispatch";
import * as handoffNotifyModule from "@/lib/airi/reply/runtime/handoff-notify";
import * as handoffStateModule from "@/lib/airi/reply/runtime/handoff-state";
import * as inboundBurstModule from "@/lib/airi/reply/runtime/inbound-burst";
import * as intentRuntimeModule from "@/lib/airi/reply/runtime/intent";
import * as managerReplyGuardModule from "@/lib/airi/reply/runtime/manager-reply-guard";
import * as mediaOnlyModule from "@/lib/airi/reply/runtime/media-only";
import * as ragRuntimeModule from "@/lib/airi/reply/runtime/rag";
import * as replyActionUtilsModule from "@/lib/airi/reply/runtime/reply-action-utils";
import * as replyTraceModule from "@/lib/airi/reply/runtime/reply-trace";
import * as runtimeScenarioModule from "@/lib/airi/reply/runtime/scenario";
import * as scenarioFollowupHandoffModule from "@/lib/airi/reply/runtime/scenario-followup-handoff";
import * as whatsappBookCallRuntimeModule from "@/lib/airi/reply/runtime/whatsapp-book-call";
import type {
  AiriScenarioRuntimeConfig,
  AiriScenarioRuntimeResolution,
} from "./scenario-runtime-types";
import * as scenarioRuntimeModule from "@/lib/airi/scenario/scenario-runtime";
import * as scenarioRuntimeDispatchModule from "@/lib/airi/scenario/scenario-runtime-dispatch";
import * as scenarioTemplateModule from "@/lib/airi/scenario/scenario-template";
import * as scenarioTemplateDynamicsModule from "@/lib/airi/scenario/scenario-template-dynamics";
import * as shouldContinueProcessingModule from "@/lib/airi/shouldContinueProcessing";
import * as workspaceBotContractModule from "@/lib/airi/workspace-bot-contract";
import * as workspaceBotDefaultModule from "@/lib/airi/workspace-bot-default";
import * as companyContextModule from "@/lib/company-context";
import * as conversationAttachmentsModule from "@/lib/conversation-attachments";
import * as googleCalendarAvailabilityModule from "@/lib/google-calendar/availability-context";
import * as companyLimitsModule from "@/lib/limits/company-limits";
import * as messageMediaUtilsModule from "@/lib/media/message-media-utils";
import * as realtimeModule from "@/lib/realtime/server";
import * as supabaseAdminModule from "@/lib/supabase/admin";
import * as telegramModule from "@/lib/telegram";
import * as flowEndpointTokenModule from "@/lib/whatsapp/flows/endpoint-token";
import MessageModule from "@/models/message";
import type {
  Channel,
  ChatDocument,
  ConversationDocument,
  MessageDocument,
} from "@/types/models";
import {
  extractWhatsAppQrReference,
  normalizeScenarioActionOutcomes,
  resolveSendableWhatsAppFlowIdentity,
  resolveWhatsAppFlowActionData,
  resolveWhatsAppFlowActionType,
  resolveWhatsAppFlowProviderSource,
  buildScenarioPromptInputAnswerText,
  buildScenarioPromptInputSourceText,
  applyGenerativeAIPickedOption,
  GENERATIVE_AI_CUSTOMER_VALUES_NOTE,
  GENERATIVE_AI_DAILY_LIMIT_WINDOW_MS,
  isScenarioFormAnswerMissingError,
  isScenarioPromptInputCapacityError,
  isScenarioPromptInputMissingError,
  labelScenarioAnswerReference,
  listScenarioAnswerReferences,
  mergePromptInputAnswersIntoScenarioState,
  quoteGenerativeAICustomerValue,
  readAwaitingScenarioPromptInputAsk,
  readCollectedPromptInputValues,
  readExpiredScenarioPromptInputAsk,
  readGenerativeAISafety,
  readScenarioAnswerReferenceValue,
  readScenarioFormAnswerTemplateValues,
  readScenarioFormSubmissions,
  readScenarioPickedOption,
  readScenarioRoutedLocations,
  readScenarioRoutedOffice,
  readSingleWhatsAppTemplateFlowButton,
  recordScenarioFormSubmission,
  SCENARIO_TRIGGER_EVENT_KIND,
  type GenerativeAIActionConfig,
  type ScenarioPromptInputUntapped,
  type ScenarioRoutedLocationEntry,
  type ScenarioRuntimeEventKind,
} from "@icecore/scenario-contracts";
import { appendGroundedReplyOptionsInlineText } from "@icecore/shared/lib/grounded-reply-options";
import type { WhatsAppNormalizedContact } from "@icecore/shared/lib/whatsapp/contact-identities";
import { getRealtimeChannelNameForConversation } from "@icecore/shared/types/sources";
import {
  createWebRequire,
  readDefaultExport as readInteropDefault,
} from "./internal/module-interop";
import { airiOrchestrationLogger, airiReplyLogger } from "./logging";
import {
  claimPromptInputChoiceNudge,
  closePromptInputAskForNoReply,
  holdServiceMessagePromptInputNode,
  planServiceMessagePromptInputChoice,
  planServiceMessagePromptInputResend,
  planServiceMessagePromptInputTurn,
  readKeptPromptInputWait,
  resolvePromptInputChoiceNudge,
  returnToPromptInputAskAfterReminder,
  shouldConsumePromptInputAnswer,
  type ScenarioPromptInputExtractor,
} from "./scenario-prompt-input-turn";
import {
  readTappedScenarioPick,
  withTappedScenarioPick,
} from "./scenario-picked-option-turn";
import {
  readSubmittedScenarioForm,
  withSubmittedScenarioForm,
} from "./scenario-form-answer-turn";
import {
  bucketScenarioLocationDistance,
  buildScenarioRoutedLocationEntry,
  isScenarioLocationRescueMessageId,
  readPendingScenarioLocationShare,
  readTurnSharedLocation,
  removeSharedLocationText,
  withRoutedScenarioLocation,
} from "./scenario-location-turn";
import { previewText, traceableChain } from "./tracing";
import {
  findGenerativeAIPromptIssue,
  readGenerativeAIAppendedCustomerText,
  resolveGenerativeAIAutoReplyActionAfterContext,
  type ActiveGenerativeAIExecution,
  type GenerativeAIAutoReplyRuntime,
  type GenerativeAIPromptIssue,
} from "./generative-ai-auto-reply";
import { isScenarioAutomationPausedByHandoff } from "./scenario-handoff-policy";
import { isAiriAutoReplyEnabled } from "./auto-reply-switch";
import { resolveWhatsAppQrScenarioTriggerText } from "./whatsapp-qr-scenario-input";

const NextResponse = {
  json(body: unknown, init?: ResponseInit): Response {
    return Response.json(body, init);
  },
};

const requireWeb = createWebRequire(import.meta.url);
const conversationModelModule = requireWeb(
  "../../../apps/web/src/models/conversation",
) as {
  Conversation?: typeof import("@/models/conversation").Conversation;
};
const Conversation = conversationModelModule.Conversation;
const Message = readInteropDefault<typeof MessageModule>(MessageModule);

const { detectAndUpdateConversationLanguageDecision } = readInteropDefault<
  typeof import("@/lib/airi/coach/coach-utils-server")
>(coachUtilsServerModule);
const { evaluateManagerReplyGuard } = readInteropDefault<
  typeof import("@/lib/airi/reply/runtime/manager-reply-guard")
>(managerReplyGuardModule);
const { fetchCompanyContextBySourceId } =
  readInteropDefault<typeof import("@/lib/company-context")>(
    companyContextModule,
  );
type CompanyContext = Awaited<ReturnType<typeof fetchCompanyContextBySourceId>>;
const { getConversationAttachmentUrlByType } = readInteropDefault<
  typeof import("@/lib/conversation-attachments")
>(conversationAttachmentsModule);
const { isMeaningfulMessageText, resolveReplyVisibleMessageText } =
  readInteropDefault<typeof import("@/lib/media/message-media-utils")>(
    messageMediaUtilsModule,
  );
const { realtime } =
  readInteropDefault<typeof import("@/lib/realtime/server")>(realtimeModule);

const { shouldAttachScenarioButtons } = readInteropDefault<
  typeof import("@/lib/airi/reply/runtime/auto-reply-guards")
>(autoReplyGuardsModule);
const {
  resolvePendingInteractiveOutboundAnchor,
  resolveAutoReplyExecutionGates,
  selectScenarioContinuationOutcome,
  shouldSkipBeforeScenarioResolution,
} = readInteropDefault<
  typeof import("@/lib/airi/reply/runtime/auto-reply-execution-gates")
>(autoReplyExecutionGatesModule);
const { resolveConversationScenariosEnabled } = readInteropDefault<
  typeof import("@/lib/airi/workspace-bot-contract")
>(workspaceBotContractModule);
const { maybeAutoResumeScenarioHandoff, updateConversationHandoffState } =
  readInteropDefault<typeof import("@/lib/airi/reply/runtime/handoff-state")>(
    handoffStateModule,
  );
const { persistSuppressedState, TypingManager } = readInteropDefault<
  typeof import("@/lib/airi/reply/runtime/auto-reply-realtime")
>(autoReplyRealtimeModule);
const { sendHandoffNotifications } =
  readInteropDefault<typeof import("@/lib/airi/reply/runtime/handoff-notify")>(
    handoffNotifyModule,
  );

const {
  assertScenarioTemplateFlowComponents,
  buildScenarioTemplateComponents,
  buildScenarioTemplateValueMap,
  resolveScenarioTemplateLanguage,
} = readInteropDefault<
  typeof import("@/lib/airi/reply/runtime/auto-reply-template-utils")
>(autoReplyTemplateUtilsModule);
const {
  shouldAllowEmptyAutoReplyInput,
  canStartUnavailableMessageScenario,
  isWhatsAppUnavailableInboundSourcePayload,
} =
  readInteropDefault<
    typeof import("@/lib/airi/reply/runtime/auto-reply-input")
  >(autoReplyInputModule);
const { isScenarioTimeoutMessageId } = readInteropDefault<
  typeof import("@/lib/airi/reply/runtime/scenario-followup-handoff")
>(scenarioFollowupHandoffModule);

const { resolvePendingConditionEventDisposition } = readInteropDefault<
  typeof import("@/lib/airi/interactive-no-reply")
>(interactiveNoReplyModule);
const { resolvePostActionAnswerMatch } = readInteropDefault<
  typeof import("@/lib/airi/post-action-answer-matching")
>(postActionAnswerMatchingModule);
const { resolveInteractiveReplyConditionTarget } = readInteropDefault<
  typeof import("@/lib/airi/scenario/scenario-runtime")
>(scenarioRuntimeModule);
const { normalizeInteractiveTriggerPayloads, resolveDefaultTriggerEventKind } =
  readInteropDefault<
    typeof import("@/lib/airi/scenario/scenario-runtime-dispatch")
  >(scenarioRuntimeDispatchModule);
const { trackMissingKnowledgeGap } = readInteropDefault<
  typeof import("@/lib/airi/rag/knowledge/knowledge-gap-tracker")
>(knowledgeGapTrackerModule);
const { createSuggestionPayload } = readInteropDefault<
  typeof import("@/lib/airi/ops/suggestion-payloads")
>(suggestionPayloadsModule);
const { resolveWhatsAppVoiceReplyIntent, sendAndPersistOutbound } =
  readInteropDefault<
    typeof import("@/lib/airi/reply/delivery/outbound-message")
  >(outboundMessageModule);
const {
  COMPANY_AIRI_AUTO_REPLY_LIMIT_EXCEEDED_CODE,
  ensureCompanyAiriAutoReplyCapacity,
} =
  readInteropDefault<typeof import("@/lib/limits/company-limits")>(
    companyLimitsModule,
  );
const {
  finalizeAssistantReplyForDelivery,
  formatFinalizedAssistantReplyForOutbound,
} =
  readInteropDefault<typeof import("@/lib/airi/reply/generation/reply-safety")>(
    replySafetyModule,
  );
const { buildFlowEndpointTokenFromConfig } = readInteropDefault<
  typeof import("@/lib/whatsapp/flows/endpoint-token")
>(flowEndpointTokenModule);
const { appendKbArticleLinksToReply, shouldAttachKbArticleLinks } =
  readInteropDefault<typeof import("@/lib/airi/reply/runtime/dispatch")>(
    dispatchModule,
  );
const {
  PRE_RUNTIME_CONTEXT_TIMEOUT_MS,
  normalizeDateIso,
  normalizeWidgetRagContext,
  runAutoReplyStage,
  withTimeoutFallback,
} =
  readInteropDefault<typeof import("@/lib/airi/reply/runtime/context")>(
    replyContextModule,
  );
const {
  resolveScenarioReplyExecutionDecision,
  resolveScenarioWhatsAppDeliveryProjection,
} = readInteropDefault<
  typeof import("@/lib/airi/reply/runtime/reply-action-utils")
>(replyActionUtilsModule);
const { resolveScenarioWhatsAppCta } = readInteropDefault<
  typeof import("@/lib/airi/reply/runtime/scenario")
>(runtimeScenarioModule);
const { buildGenerativeAIInboundCandidateForTurn } = readInteropDefault<
  typeof import("@/lib/airi/reply/runtime/scenario")
>(runtimeScenarioModule);
const { claimGenerativeExecution, parsePendingGenerativeExecution } =
  readInteropDefault<
    typeof import("@/lib/airi/reply/runtime/generative-ai-execution-store")
  >(generativeAIExecutionStoreModule);
const {
  handleWhatsAppBookCallTap,
  resolveScenarioWhatsAppAppointmentAvailability,
} = readInteropDefault<
  typeof import("@/lib/airi/reply/runtime/whatsapp-book-call")
>(whatsappBookCallRuntimeModule);
const { estimateRagResponseConfidence, evaluateReplyDeliveryGate } =
  readInteropDefault<
    typeof import("@/lib/airi/reply/delivery/reply-delivery-gate")
  >(deliveryGateModule);
const { runIntentFastPath } =
  readInteropDefault<typeof import("@/lib/airi/reply/runtime/intent")>(
    intentRuntimeModule,
  );
const { supabaseAdmin } =
  readInteropDefault<typeof import("@/lib/supabase/admin")>(
    supabaseAdminModule,
  );
const { buildGoogleCalendarAvailabilityContext } = readInteropDefault<
  typeof import("@/lib/google-calendar/availability-context")
>(googleCalendarAvailabilityModule);
const { buildMediaOnlyClarification } =
  readInteropDefault<typeof import("@/lib/airi/reply/runtime/media-only")>(
    mediaOnlyModule,
  );
const {
  clearSuppressedStateAfterDelivery,
  captureTemporalDeferredCommand,
  completeScenarioAfterDelivery,
  persistAiriReplyTraceAfterDelivery,
  publishAiriSuggestionAfterDelivery,
  trackMissingKnowledgeGapAfterDelivery,
  updateSuggestionMessageIdAfterDelivery,
} = readInteropDefault<
  typeof import("@/lib/airi/reply/delivery/temporal-outbound")
>(temporalOutboundModule);
const { persistAiriReplyTrace, resolveReplyTraceGroundingSourceKind } =
  readInteropDefault<typeof import("@/lib/airi/reply/runtime/reply-trace")>(
    replyTraceModule,
  );
const { runRagReplyFlow } =
  readInteropDefault<typeof import("@/lib/airi/reply/runtime/rag")>(
    ragRuntimeModule,
  );
const { TelegramDraftReveal, safeSetMessageReaction } =
  readInteropDefault<typeof import("@/lib/telegram")>(telegramModule);
const { formatReplyMarkdownForTelegramHtml } = readInteropDefault<
  typeof import("@/lib/airi/reply/delivery/reply-rich-text-format")
>(replyRichTextFormatModule);
const { ensureReplyLanguage, resolveCustomerReplyLanguageContext } =
  readInteropDefault<
    typeof import("@/lib/airi/reply/generation/reply-language")
  >(replyLanguageModule);

const {
  resolveFirstReachableActionFromNode,
  resolvePostActionConditionBranchTarget,
  resolvePostActionConditionSourceHandleTarget,
  resolveScenarioLocationRouteTarget,
} = readInteropDefault<typeof import("@/lib/airi/scenario/scenario-runtime")>(
  scenarioRuntimeModule,
);

const { applyScenarioReplyTemplate } = readInteropDefault<
  typeof import("@/lib/airi/scenario/scenario-template")
>(scenarioTemplateModule);
const {
  resolveCalendarAvailabilityForScenarioTemplate,
  toScenarioCalendarTemplateAvailability,
} = readInteropDefault<
  typeof import("@/lib/airi/scenario/scenario-template-dynamics")
>(scenarioTemplateDynamicsModule);
const { shouldContinueProcessing } = readInteropDefault<
  typeof import("@/lib/airi/shouldContinueProcessing")
>(shouldContinueProcessingModule);
const { getWorkspaceBotRuntimeSettings } = readInteropDefault<
  typeof import("@/lib/airi/workspace-bot-default")
>(workspaceBotDefaultModule);
const { resolveInboundBurstOwnership } =
  readInteropDefault<typeof import("@/lib/airi/reply/runtime/inbound-burst")>(
    inboundBurstModule,
  );

if (!Conversation) {
  throw new Error("Failed to load required Airi runtime models");
}

export type AiriAutoReplyParams = {
  type: Channel;
  scenarioOverrideId?: string;
  scenarioTriggerNodeId?: string;
  skipTriggerMatch?: boolean;
  proactiveTrigger?: boolean;
  suppressGeneralAutoReply?: boolean;
  /** Re-evaluate entry after verified content recovery without advancing an existing journey. */
  messageRecoveryRevision?: string;
  /** The admitted provider event had unavailable content, even if its message later recovered. */
  whatsappMessageContentUnavailable?: boolean;
  triggerEventKind?: ScenarioRuntimeEventKind;
  followUpInstruction?: string;
  systemPromptOverride?: string;
  botToken?: string;
  /** Telegram AI lifecycle reactions are disabled unless the source opts in. */
  telegramReactionsEnabled?: boolean;
  whatsAppInfo?: {
    phoneNumberId?: string;
    accessToken?: string;
    messagingAccountId?: string;
    wabaId?: string;
    contactData: WhatsAppNormalizedContact;
  };
  instagramInfo?: {
    pageId: string;
    accessToken: string;
    recipientId?: string;
    authMethod?: string;
    threadType?: "dm" | "comment";
    commentId?: string;
  };
  newMessage: MessageDocument;
  conversation: ConversationDocument;
  workspaceId: string;
  chatDocument: ChatDocument;
  chatId?: string | number;
  chatType?: string;
  /**
   * When set, the incoming event was a Telegram quick-reply button click.
   * Passed to `resolveActiveScenarioRuntime` so branch action nodes with
   * matching `telegramBranchPayload` can resolve deterministically.
   */
  quickReplyPayload?: string | null;
  /**
   * Raw `interactive.nfm_reply.response_json` payload from a WhatsApp Flow
   * completion event. Used to resolve matching `flowBranchOptionId` actions.
   */
  whatsAppFlowResponseJson?: string | null;
  /**
   * The Temporal activity loaded this message and conversation directly from
   * Mongo immediately before invoking the runtime. Legacy/direct callers omit
   * this flag and retain the defensive refresh below.
   */
  runtimeHydrated?: boolean;
  /** Set only by authoritative confirmed-conversion hydration, never receipt analysis. */
  confirmedPaymentScenario?: ConfirmedPaymentScenarioSnapshot;
  behaviorScenarioUpdatedAt?: string;
  behaviorBlockedReason?: string;
  /** Set only by this runtime after the company capacity gate succeeds. */
  runtimeCapacityVerifiedAt?: string;
};

function isPendingConditionEligibleTrigger(
  triggerEventKind?: ScenarioRuntimeEventKind | null,
): boolean {
  return (
    !triggerEventKind ||
    triggerEventKind === "payment_detected" ||
    triggerEventKind === SCENARIO_TRIGGER_EVENT_KIND.noHumanReplyTimeout ||
    triggerEventKind === SCENARIO_TRIGGER_EVENT_KIND.inboundMessage ||
    isScenarioInteractiveReplyEventKind(triggerEventKind)
  );
}

function isPendingAnswerMatchTextEvent(
  triggerEventKind?: ScenarioRuntimeEventKind | null,
): boolean {
  return (
    !triggerEventKind ||
    triggerEventKind === SCENARIO_TRIGGER_EVENT_KIND.inboundMessage
  );
}

/** The armed wait a completion must still find, so a newer one is left alone. */
function readExpectedPendingState(state: ConversationScenarioState | null) {
  return state?.pendingConditionNodeId && state.pendingSourceActionNodeId
    ? {
        conditionNodeId: state.pendingConditionNodeId,
        sourceActionNodeId: state.pendingSourceActionNodeId,
        pendingStartedAt: state.pendingStartedAt || null,
        lastOutboundMessageId: state.pendingLastOutboundMessageId || null,
      }
    : undefined;
}

function buildScenarioOutboundOrigin(
  scenarioRuntime: AiriScenarioRuntimeConfig | null | undefined,
) {
  if (!scenarioRuntime?.scenarioId) return undefined;
  return {
    scenarioId: scenarioRuntime.scenarioId,
    scenarioName: scenarioRuntime.scenarioName,
    actionNodeId:
      scenarioRuntime.selectedActionNodeId ||
      scenarioRuntime.nextActionNodeId ||
      undefined,
  };
}

const airiAutoReplyImpl = async (
  params: AiriAutoReplyParams,
  scenarioDependencies: ScenarioRuntimeDependencies<ConversationDocument>,
) => {
  const {
    loadActiveScenarioSnapshot,
    resolveActiveScenarioRuntime,
    clearPendingConditionStateAndPersist,
    completeLockedScenarioAndPersist,
    finalizeScenarioResolution,
    findLatestScenarioActionOutbound,
    persistPendingConditionState,
    persistScenarioState,
  } = scenarioDependencies;
  const turnStartedAt = Date.now();
  const { newMessage, conversation, workspaceId, type, chatDocument } = params;
  // The chat is shared by every workspace the customer writes to.
  const replySourceId =
    resolveConversationReplySourceId({
      workspaceId,
      conversation,
      chat: chatDocument,
    }) || undefined;
  const isProactiveTrigger = Boolean(params.proactiveTrigger);
  const fastModeEnv = (process.env.AIRI_FAST_RAG || "").toLowerCase();
  const telegramFastModeEnv = (
    process.env.AIRI_FAST_RAG_TELEGRAM || ""
  ).toLowerCase();
  /**
   * Telegram defaults to fast RAG (lighter retrieval: no HyDE/rerank/translation LLM prep,
   * smaller KB fan-out). Opt out with `AIRI_FAST_RAG_TELEGRAM=false`.
   * All channels: `AIRI_FAST_RAG=true` still forces fast mode.
   */
  const fastMode =
    fastModeEnv === "true" ||
    (type === "telegram" && telegramFastModeEnv !== "false");
  const conversationId = String(conversation._id);
  const currentMessageId = String(newMessage._id);
  const isConfirmedPaymentTurn =
    params.triggerEventKind === "payment_detected" ||
    Boolean(params.confirmedPaymentScenario) ||
    currentMessageId.startsWith("confirmed-payment:");
  const triggerWhatsAppReferral = (newMessage.whatsappReferral ||
    conversation.whatsappReferral ||
    null) as Partial<WhatsAppReferralFields> | null;
  const isScenarioTimeoutTurn = isScenarioTimeoutMessageId(currentMessageId);
  const isLocationRescueTurn =
    isScenarioLocationRescueMessageId(currentMessageId);
  const currentTimestamp = newMessage.date.getTime();
  const typing = new TypingManager(params);
  const diagnostics: AutoReplyDiagnosticsContext = {
    workspaceId,
    conversationId,
    messageId: currentMessageId,
    channel: type,
    triggerEventKind: params.triggerEventKind,
    quickReplyPayload: params.quickReplyPayload || null,
  };
  const buildOrchestrationLogContext = (
    note: string,
    context?: Record<string, unknown>,
  ) => ({
    ...diagnostics,
    note,
    ...(context || {}),
  });
  const logOrchestrationInfo = (
    note: string,
    context?: Record<string, unknown>,
  ) => {
    airiOrchestrationLogger.info(
      "airi.orchestration",
      buildOrchestrationLogContext(note, context),
    );
  };
  const logOrchestrationWarn = (
    note: string,
    context?: Record<string, unknown>,
  ) => {
    airiOrchestrationLogger.warn(
      "airi.orchestration",
      buildOrchestrationLogContext(note, context),
    );
  };
  const logOrchestrationError = (
    note: string,
    error: unknown,
    context?: Record<string, unknown>,
  ) => {
    airiOrchestrationLogger.error(
      "airi.orchestration",
      error,
      buildOrchestrationLogContext(note, context),
    );
  };
  let lastTimingAt = turnStartedAt;
  const logTiming = (stage: string, context?: Record<string, unknown>) => {
    const now = Date.now();
    logOrchestrationInfo("turn_timing", {
      stage,
      elapsedMs: now - turnStartedAt,
      deltaMs: now - lastTimingAt,
      ...(context || {}),
    });
    lastTimingAt = now;
  };
  /**
   * Arms the wait an interactive reply selected: a tapped choice's
   * branch-scoped condition or a delayed CTA follow-up. A delayed CTA follow-up
   * needs the tapped action's own message; when no prior wait carries it, as
   * after a bulk send, it is read from the conversation, and a follow-up that
   * cannot be anchored is not armed. Returns the state to resolve with.
   */
  const armInteractiveReplyConditionWait = async (input: {
    baseState: unknown;
    scenarioId: string;
    scenarioName: unknown;
    sourceActionNodeId: string;
    target: NonNullable<
      ReturnType<typeof resolveInteractiveReplyConditionTarget>
    >;
    carriedAnchor: string | null;
  }): Promise<unknown> => {
    const conditionNodeId = input.target.conditionNode.id;
    let anchor = input.carriedAnchor;
    if (!anchor && isScenarioActionBranchDelayVirtualNodeId(conditionNodeId)) {
      anchor = await findLatestScenarioActionOutbound({
        workspaceId,
        conversationId,
        scenarioId: input.scenarioId,
        actionNodeId: input.sourceActionNodeId,
      });
      if (!anchor) {
        logOrchestrationWarn("delayed_cta_follow_up_not_armed", {
          reason: "missing_outbound_anchor",
          scenarioId: input.scenarioId,
          actionNodeId: input.sourceActionNodeId,
          conditionNodeId,
        });
        return input.baseState;
      }
    }
    return persistPendingConditionState({
      conversationId: String(conversation._id),
      baseState: input.baseState,
      scenarioId: input.scenarioId,
      scenarioName:
        typeof input.scenarioName === "string" && input.scenarioName.trim()
          ? input.scenarioName.trim()
          : "Scenario",
      sourceActionNodeId: input.sourceActionNodeId,
      conditionNodeId,
      pathNodeIds: input.target.pathNodeIds,
      pendingLastOutboundMessageId: anchor,
      messageId: currentMessageId,
      startedAt: newMessage.date || new Date(),
    }).catch((error) => {
      if (isScenarioPendingWriteCoordinationError(error)) throw error;
      logOrchestrationWarn("persist_interactive_reply_condition_state_failed", {
        conversationId: String(conversation._id),
        scenarioId: input.scenarioId,
        conditionNodeId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return input.baseState;
    });
  };

  let telegramReactionAiEnabled = false;

  /**
   * Fire-and-forget emoji reaction on the inbound Telegram message.
   *
   * Used to give the user immediate visual feedback as Airi moves through
   * its reply lifecycle:
   *   - "👀" right after we commit to processing (before RAG, LLM, etc.)
   *   - "⚡" once the real reply has been persisted & delivered
   *   - "🙏" when Airi hands the conversation off to a human
   *
   * Passing `null` clears the bot's existing reaction. Every call is safe:
   * the underlying helper swallows API errors (e.g. business-connection chats
   * where bots can't react, or groups with restricted permissions), so a
   * failing reaction never takes the auto-reply down.
   *
   * Why only Telegram: `setMessageReaction` is a Telegram Bot API method.
   * Requires source opt-in and chat AI enablement, including scenario turns.
   * For other channels this is a no-op.
   */
  const fireTelegramReaction = (emoji: string | null): void => {
    if (
      type !== "telegram" ||
      params.telegramReactionsEnabled !== true ||
      !telegramReactionAiEnabled
    ) {
      return;
    }
    const rawPlatformMessageId =
      typeof newMessage.messageId === "string" ||
      typeof newMessage.messageId === "number"
        ? newMessage.messageId
        : null;
    if (rawPlatformMessageId === null) return;
    const numericMessageId = Number(rawPlatformMessageId);
    if (!Number.isFinite(numericMessageId) || numericMessageId <= 0) return;
    const rawChatId = params.chatId;
    const chatIdStr =
      typeof rawChatId === "number"
        ? String(rawChatId)
        : typeof rawChatId === "string"
          ? rawChatId.trim()
          : "";
    if (!chatIdStr) return;
    void safeSetMessageReaction(
      chatIdStr,
      numericMessageId,
      emoji,
      params.botToken ? { botToken: params.botToken } : undefined,
    );
  };

  // 3. Concurrency: turns for one conversation run one at a time in its
  // Temporal workflow, and the Mongo preparation claim fences a replayed
  // turn, so no separate processing lock is taken here.
  // Every handled exit stops typing first.
  const finishTurn = async (body: Record<string, unknown>) => {
    typing.stop();
    return NextResponse.json(body);
  };
  const completeScenarioOrWarn = async (
    label: string,
    input: Omit<
      Parameters<typeof completeScenarioAfterDelivery>[0],
      "conversationId"
    >,
  ) => {
    await completeScenarioAfterDelivery({ conversationId, ...input }).catch(
      (error) => {
        logOrchestrationWarn(label, {
          conversationId,
          scenarioId: input.scenarioRuntime?.scenarioId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      },
    );
  };

  // Declared at function scope (not inside `try`) so the catch block can
  // tear down a live animated draft if we fail mid-stream — otherwise the
  // bubble would hang on the user's screen until Telegram's client-side
  // draft timeout fires (~4s).
  let telegramDraftReveal: InstanceType<typeof TelegramDraftReveal> | null =
    null;

  try {
    // 1. Initial Validation
    const autoEnabled = isAiriAutoReplyEnabled();
    let payloadText =
      typeof newMessage.text === "string" ? newMessage.text.trim() : "";
    const followUpInstruction =
      typeof params.followUpInstruction === "string"
        ? params.followUpInstruction.trim()
        : "";
    const systemPromptOverride =
      typeof params.systemPromptOverride === "string"
        ? params.systemPromptOverride.trim()
        : "";
    if (!autoEnabled) {
      logOrchestrationInfo("auto_reply_disabled", {
        autoEnabled,
        workspaceId,
      });
      return NextResponse.json({ status: "ok" });
    }

    // 2. State & Bot Toggle Check (load workspace runtime settings lazily)
    const runtimeHydrated = params.runtimeHydrated === true;
    const [convToggle, persistedCurrentMessage] = await Promise.all([
      runAutoReplyStage({
        label: "load-conversation-bot-state",
        diagnostics,
        action: () =>
          runtimeHydrated
            ? Promise.resolve(conversation as LeanConversationBotState)
            : Conversation.findById(conversation._id)
                .select(
                  "airi_bot_enabled airi_scenarios_enabled airi_enabled preferred_language airi_last_customer_language airi_last_customer_language_at airi_last_customer_language_source sourceId airi_scenario_state airi_pending_generative_execution airi_handoff_active airi_handoff_started_at airi_handoff_restore_bot_enabled airi_handoff_source airi_handoff_reason airi_last_suppressed_reason",
                )
                .lean<LeanConversationBotState>(),
      }),
      runAutoReplyStage({
        label: "load-persisted-message",
        diagnostics,
        action: () =>
          isScenarioTimeoutTurn || isConfirmedPaymentTurn
            ? Promise.resolve(null)
            : runtimeHydrated
              ? Promise.resolve(newMessage)
              : Message.findById(newMessage._id)
                  .select(
                    "author direction channel date ragContext text audioAnalysis videoAnalysis imageUrl mediaType mimeType fileName whatsappMediaId attachments rawSourcePayload whatsappRecoveryRevision",
                  )
                  .populate({ path: "author", select: "_id isBot" })
                  .lean<{
                    _id?: unknown;
                    rawSourcePayload?: unknown;
                    whatsappRecoveryRevision?: string;
                    author?: unknown;
                    direction?: "inbound" | "outbound";
                    channel?: Channel;
                    date?: Date;
                    ragContext?: string | null;
                    text?: string | null;
                    audioAnalysis?: string | null;
                    videoAnalysis?: string | null;
                    imageUrl?: string | null;
                    mediaType?: string | null;
                    mimeType?: string | null;
                    fileName?: string | null;
                    whatsappMediaId?: string | null;
                    attachments?: Array<{
                      url?: string | null;
                      contentType?: string | null;
                    }> | null;
                  } | null>(),
      }),
    ]);

    let conv = Array.isArray(convToggle) ? convToggle[0] : convToggle;
    const unavailableInboundContent =
      type === "whatsapp" &&
      (persistedCurrentMessage?.direction || newMessage.direction) ===
        "inbound" &&
      (Boolean(params.whatsappMessageContentUnavailable) ||
        isWhatsAppUnavailableInboundSourcePayload(
          newMessage.rawSourcePayload,
        ) ||
        isWhatsAppUnavailableInboundSourcePayload(
          persistedCurrentMessage?.rawSourcePayload,
        ));
    const recoveredInboundContent =
      type === "whatsapp" &&
      Boolean(
        params.messageRecoveryRevision ||
          // Older unavailable contexts predate explicit provenance. Their
          // suppression flag plus a verified canonical upgrade stays entry-only.
          (params.suppressGeneralAutoReply &&
            (persistedCurrentMessage?.whatsappRecoveryRevision ||
              newMessage.whatsappRecoveryRevision)),
      );
    if (unavailableInboundContent || recoveredInboundContent) {
      if (
        !canStartUnavailableMessageScenario({
          scenarioState: conv?.airi_scenario_state,
          handoffActive: conv?.airi_handoff_active,
          pendingGenerativeExecution: conv?.airi_pending_generative_execution,
        }) ||
        params.proactiveTrigger ||
        params.scenarioOverrideId ||
        params.scenarioTriggerNodeId ||
        params.quickReplyPayload ||
        params.whatsAppFlowResponseJson ||
        params.skipTriggerMatch ||
        (params.triggerEventKind &&
          params.triggerEventKind !==
            SCENARIO_TRIGGER_EVENT_KIND.inboundMessage)
      ) {
        return NextResponse.json({
          status: "ok",
          skipped_unavailable_message_existing_journey: true,
        });
      }
      // The provider supplied an inbound event, but none of the customer's words.
      if (unavailableInboundContent) payloadText = "";
    }
    let activeGenerativeExecution = parsePendingGenerativeExecution(
      conv?.airi_pending_generative_execution,
    );
    const hasExplicitAutoReplyTrigger =
      Boolean(params.proactiveTrigger) ||
      Boolean(params.scenarioOverrideId) ||
      Boolean(params.scenarioTriggerNodeId) ||
      Boolean(params.triggerEventKind) ||
      Boolean(params.quickReplyPayload) ||
      Boolean(
        typeof params.whatsAppFlowResponseJson === "string" &&
          params.whatsAppFlowResponseJson.trim().length > 0,
      ) ||
      Boolean(params.followUpInstruction) ||
      Boolean(params.systemPromptOverride);

    const widgetRagContext =
      type === "web_widget"
        ? normalizeWidgetRagContext(
            persistedCurrentMessage?.ragContext ?? newMessage.ragContext,
          )
        : "";

    const effectiveDirection =
      persistedCurrentMessage?.direction || newMessage.direction;
    if (effectiveDirection !== "inbound") {
      logOrchestrationInfo("skipped_non_inbound", {
        workspaceId,
        conversationId: String(conversation._id),
        messageId: currentMessageId,
        direction: effectiveDirection,
      });
      return NextResponse.json({ status: "ok", skipped_non_inbound: true });
    }

    let inboundAuthorId: string | undefined;
    let inboundAuthorIsBot = false;
    const inboundAuthor = persistedCurrentMessage?.author;
    if (
      inboundAuthor &&
      typeof inboundAuthor === "object" &&
      "_id" in (inboundAuthor as Record<string, unknown>)
    ) {
      const authorObj = inboundAuthor as { _id?: unknown; isBot?: boolean };
      if (authorObj._id !== null && authorObj._id !== undefined) {
        inboundAuthorId = String(authorObj._id);
      }
      inboundAuthorIsBot = Boolean(authorObj.isBot);
    } else if (inboundAuthor !== null && inboundAuthor !== undefined) {
      inboundAuthorId = String(inboundAuthor);
    }

    if (inboundAuthorIsBot || inboundAuthorId === "0") {
      logOrchestrationInfo("skipped_bot_authored_inbound", {
        workspaceId,
        conversationId: String(conversation._id),
        messageId: currentMessageId,
        inboundAuthorId,
      });
      return NextResponse.json({ status: "ok", skipped_bot_author: true });
    }

    if (!hasExplicitAutoReplyTrigger || unavailableInboundContent) {
      const inboundBurst = await runAutoReplyStage({
        label: "resolve-inbound-burst",
        diagnostics,
        action: () =>
          resolveInboundBurstOwnership({
            conversationId,
            currentMessageId,
          }),
      });

      if (!inboundBurst.shouldProcess) {
        logOrchestrationInfo("skipped_inbound_burst_ownership", {
          reason: inboundBurst.reason,
          burstOwnerMessageId: inboundBurst.burstOwnerMessageId || null,
          answeredByMessageId: inboundBurst.answeredByMessageId || null,
        });
        return NextResponse.json({
          status: "ok",
          skipped_burst_reason: inboundBurst.reason,
          burst_owner_message_id: inboundBurst.burstOwnerMessageId,
          answered_by_message_id: inboundBurst.answeredByMessageId,
        });
      }

      if (inboundBurst.burstText && !unavailableInboundContent) {
        payloadText = inboundBurst.burstText;
      }

      logOrchestrationInfo("inbound_burst_resolved", {
        latestBurstMessageId: inboundBurst.latestBurstMessageId,
        burstMessageIds: inboundBurst.burstMessageIds,
        burstTextPreview:
          inboundBurst.burstText && !unavailableInboundContent
            ? inboundBurst.burstText.slice(0, 120)
            : null,
      });
    }

    const inboundHasMedia = Boolean(
      persistedCurrentMessage?.imageUrl ||
        newMessage.imageUrl ||
        persistedCurrentMessage?.whatsappMediaId ||
        newMessage.whatsappMediaId ||
        getConversationAttachmentUrlByType(
          persistedCurrentMessage?.attachments ?? newMessage.attachments,
          "any",
        ).url,
    );
    const hasSubstantiveInbound =
      hasExplicitAutoReplyTrigger ||
      isMeaningfulMessageText(payloadText) ||
      inboundHasMedia;

    const workspaceBotSettings = await runAutoReplyStage({
      label: "load-workspace-bot-settings",
      diagnostics,
      action: () => getWorkspaceBotRuntimeSettings(workspaceId),
    });

    let conversationBotEnabled = Boolean(
      conv?.airi_bot_enabled ?? conv?.airi_enabled,
    );
    const conversationScenariosEnabled = resolveConversationScenariosEnabled(
      conv,
      workspaceBotSettings.defaultScenariosEnabled,
    );
    let autoReplySuppressedByRuntimeLock: {
      reason: "handoff_lock" | "manager_reply_guard";
      responseBody: Record<string, unknown>;
    } | null = null;

    if (isScenarioAutomationPausedByHandoff(conv?.airi_handoff_active)) {
      if (isScenarioTimeoutTurn || isConfirmedPaymentTurn) {
        logOrchestrationInfo("scenario_followup_continues_through_handoff", {
          workspaceId,
          conversationId,
          messageId: currentMessageId,
          handoffSource: conv?.airi_handoff_source || null,
          handoffReason: conv?.airi_handoff_reason || null,
        });
      } else {
        const mayAutoResumeHandoff = hasSubstantiveInbound;
        const handoffResumeDecision = mayAutoResumeHandoff
          ? await runAutoReplyStage({
              label: "maybe-resume-scenario-handoff",
              diagnostics,
              meta: {
                handoffSource: conv?.airi_handoff_source || null,
                hasSubstantiveInbound,
              },
              action: () =>
                maybeAutoResumeScenarioHandoff({
                  conversationId,
                  snapshot: conv,
                  inboundAt: newMessage.date,
                  hasSubstantiveInbound,
                }),
            })
          : { resumed: false, blockedByHumanReply: false };

        if (!handoffResumeDecision.resumed) {
          conversationBotEnabled = false;
          autoReplySuppressedByRuntimeLock = {
            reason: "handoff_lock",
            responseBody: {
              status: "ok",
              skipped_by_handoff_lock: true,
              blocked_by_human_reply: handoffResumeDecision.blockedByHumanReply,
            },
          };
          logOrchestrationInfo("skipped_handoff_lock", {
            workspaceId,
            conversationId,
            messageId: currentMessageId,
            handoffSource: conv?.airi_handoff_source || null,
            handoffReason: conv?.airi_handoff_reason || null,
            blockedByHumanReply: handoffResumeDecision.blockedByHumanReply,
            scenarioPathContinues: conversationScenariosEnabled,
          });
          if (!conversationScenariosEnabled) {
            return NextResponse.json(
              autoReplySuppressedByRuntimeLock.responseBody,
            );
          }
        } else {
          conversationBotEnabled =
            typeof conv?.airi_handoff_restore_bot_enabled === "boolean"
              ? conv.airi_handoff_restore_bot_enabled
              : true;
          logOrchestrationInfo("auto_resumed_scenario_handoff", {
            workspaceId,
            conversationId,
            messageId: currentMessageId,
            handoffSource: conv?.airi_handoff_source || null,
            restoredBotEnabled: conversationBotEnabled,
          });
        }
      }
    }

    const executionGates = resolveAutoReplyExecutionGates({
      autoReplyEnabled: conversationBotEnabled,
      scenariosEnabled: conversationScenariosEnabled,
    });
    const scenarioOnlyMode =
      executionGates.canResolveScenarios && !executionGates.canDeliverAutoReply;
    telegramReactionAiEnabled = executionGates.canDeliverAutoReply;

    // React only after resolving chat AI and handoff gates. Scenario-only
    // processing must stay silent even when the source opts into reactions.
    fireTelegramReaction("👀");

    // Shadow mode always ON for auto-replies: scenario execution is gated separately.
    if (!conversationBotEnabled) {
      logOrchestrationInfo("shadow_mode_conversation_disabled", {
        workspaceId,
        conversationId: String(conversation._id),
      });
    }
    if (!conversationScenariosEnabled) {
      logOrchestrationInfo("scenario_runtime_conversation_disabled", {
        workspaceId,
        conversationId: String(conversation._id),
      });
    }

    const deliverySeed = [
      workspaceId,
      String(conversation._id),
      currentMessageId,
    ].join(":");
    const evaluateDelivery = (
      responseConfidence?: number | null,
      options?: { scenarioDelivery?: boolean },
    ) =>
      evaluateReplyDeliveryGate({
        botEnabled: options?.scenarioDelivery
          ? executionGates.canResolveScenarios
          : executionGates.canDeliverAutoReply,
        shadowModeEnabled: true,
        rolloutPercentage: 100,
        minConfidence: 0,
        seed: deliverySeed,
        responseConfidence,
      });

    if (
      shouldSkipBeforeScenarioResolution(
        executionGates,
        hasExplicitAutoReplyTrigger,
      )
    ) {
      logOrchestrationInfo("airi_execution_pre_resolution_skip", {
        workspaceId,
        conversationId: String(conversation._id),
        messageId: currentMessageId,
        autoReplyEnabled: executionGates.canDeliverAutoReply,
        scenariosEnabled: executionGates.canResolveScenarios,
        triggerEventKind: params.triggerEventKind || null,
      });
      return NextResponse.json({
        status: "ok",
        skipped_airi_disabled: true,
        pre_delivery_gate: true,
      });
    }

    const managerGuardChannel =
      persistedCurrentMessage?.channel || newMessage.channel || type;
    const managerGuardSourceId = conv?.sourceId || replySourceId;
    const evaluateCurrentManagerReplyGuard = () =>
      runAutoReplyStage({
        label: "evaluate-manager-reply-guard",
        diagnostics,
        meta: {
          inboundAuthorId: inboundAuthorId || null,
          managerGuardChannel,
          managerGuardSourceId: managerGuardSourceId || null,
        },
        action: () =>
          evaluateManagerReplyGuard({
            workspaceId,
            conversationId,
            inboundAuthorId,
            channel: managerGuardChannel,
            sourceId: managerGuardSourceId,
            inboundAt:
              persistedCurrentMessage?.date || newMessage.date || new Date(),
          }),
      });
    const persistManagerReplyGuardSuppression = async (
      decision: Awaited<ReturnType<typeof evaluateCurrentManagerReplyGuard>>,
    ): Promise<NonNullable<typeof autoReplySuppressedByRuntimeLock>> => {
      try {
        await persistSuppressedState({
          workspaceId,
          conversationId: String(conversation._id),
          reason: decision.reason || "manager_recently_replied",
          managerUserId: decision.managerUserId,
          messageId: currentMessageId,
          channel: type,
        });
      } catch (error) {
        logOrchestrationWarn("persist_suppression_state_failed", {
          conversationId: String(conversation._id),
          messageId: currentMessageId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }

      return {
        reason: "manager_reply_guard",
        responseBody: {
          status: "ok",
          skipped_by_manager_guard: true,
          reason: decision.reason,
        },
      };
    };
    const guardDecision =
      executionGates.canResolveScenarios || !executionGates.canDeliverAutoReply
        ? { skip: false }
        : await evaluateCurrentManagerReplyGuard();

    if (guardDecision.skip) {
      autoReplySuppressedByRuntimeLock =
        await persistManagerReplyGuardSuppression(guardDecision);

      // A human manager is already on it — replace the "👀" ack with "🙏"
      // so the customer sees "we're on it, a human is handling this".
      fireTelegramReaction("🙏");
      logOrchestrationInfo("skipped_manager_reply_guard", {
        workspaceId,
        conversationId: String(conversation._id),
        messageId: currentMessageId,
        reason: guardDecision.reason,
        managerUserId: guardDecision.managerUserId,
      });
      return NextResponse.json(autoReplySuppressedByRuntimeLock.responseBody);
    }

    const storedReplyVisibleText = resolveReplyVisibleMessageText({
      text: persistedCurrentMessage?.text ?? newMessage.text,
      audioAnalysis: persistedCurrentMessage?.audioAnalysis,
      videoAnalysis: persistedCurrentMessage?.videoAnalysis,
      mediaType: persistedCurrentMessage?.mediaType ?? newMessage.mediaType,
    }).text;
    const inboundTextCandidate = unavailableInboundContent
      ? ""
      : isMeaningfulMessageText(payloadText)
        ? payloadText
        : storedReplyVisibleText;
    const normalizedMediaType = String(
      persistedCurrentMessage?.mediaType || newMessage.mediaType || "",
    ).toLowerCase();
    const fallbackAttachment = getConversationAttachmentUrlByType(
      persistedCurrentMessage?.attachments,
      "any",
    );
    const inboundMediaUrl =
      persistedCurrentMessage?.imageUrl ||
      newMessage.imageUrl ||
      fallbackAttachment.url;
    const inboundMediaMimeType =
      persistedCurrentMessage?.mimeType ||
      newMessage.mimeType ||
      fallbackAttachment.contentType;
    const generativeInbound = unavailableInboundContent
      ? null
      : buildGenerativeAIInboundCandidateForTurn({
          persistedMessage: persistedCurrentMessage as MessageDocument | null,
          direction: persistedCurrentMessage?.direction,
          synthetic: isScenarioTimeoutTurn,
          proactive: Boolean(params.proactiveTrigger),
        });
    const inboundMediaIsPaymentCandidate =
      Boolean(inboundMediaUrl) &&
      (normalizedMediaType === "image" ||
        normalizedMediaType === "document" ||
        (inboundMediaMimeType || "").toLowerCase().startsWith("image/") ||
        (inboundMediaMimeType || "").toLowerCase() === "application/pdf");

    const inputText = inboundTextCandidate;

    const normalizedInputText = isMeaningfulMessageText(inputText)
      ? inputText.trim()
      : "";
    const inboundTextForScenario = normalizedInputText || followUpInstruction;
    const inboundChannelForQr =
      persistedCurrentMessage?.channel || newMessage.channel || type;
    const whatsappQrExtracted =
      inboundChannelForQr === "whatsapp" && inboundTextForScenario
        ? extractWhatsAppQrReference(inboundTextForScenario)
        : null;
    // Marker-free text for matching/RAG/AI; raw kept for Scenario QR resolve.
    const effectiveInputText = whatsappQrExtracted
      ? whatsappQrExtracted.effectiveText
      : inboundTextForScenario;
    const scenarioTriggerMessageText = resolveWhatsAppQrScenarioTriggerText({
      channel: inboundChannelForQr,
      sourceId: conversation.sourceId,
      rawText: inboundTextForScenario,
      effectiveText: effectiveInputText,
    });
    const allowEmptyInputForScenarioTrigger =
      unavailableInboundContent ||
      isConfirmedPaymentTurn ||
      shouldAllowEmptyAutoReplyInput(params.triggerEventKind);
    const hasWhatsAppQrReferenceMarker = Boolean(
      whatsappQrExtracted &&
        (whatsappQrExtracted.referenceCode ||
          whatsappQrExtracted.effectiveText !== whatsappQrExtracted.rawText),
    );
    if (
      !effectiveInputText &&
      !hasWhatsAppQrReferenceMarker &&
      !inboundHasMedia &&
      !inboundMediaIsPaymentCandidate &&
      !allowEmptyInputForScenarioTrigger
    ) {
      logOrchestrationInfo("skipped_empty_input_no_transcript", {
        autoEnabled,
        hasText: false,
        workspaceId,
        conversationId: String(conversation._id),
        messageId: currentMessageId,
        mediaType: normalizedMediaType || null,
        triggerEventKind: params.triggerEventKind || null,
      });
      return NextResponse.json({ status: "ok", skipped_empty_input: true });
    }

    const checkPoint = async (
      label: string,
      options: { preserveScenarioDelivery?: boolean } = {},
    ) => {
      const proceed = await shouldContinueProcessing(
        workspaceId,
        String(conversation._id),
        currentMessageId,
        currentTimestamp,
        {
          preserveScenarioDelivery: options.preserveScenarioDelivery,
          checkpointLabel: label,
        },
      );
      if (!proceed) {
        logOrchestrationInfo("cancelled_checkpoint", { label });
        typing.stop();
        return false;
      }
      return true;
    };

    if (unavailableInboundContent || recoveredInboundContent) {
      // Hydration ran earlier; a prior turn may have started a scenario or
      // handed this conversation to a manager in the meantime.
      const latest = await Conversation.findById(conversationId)
        .select(
          "airi_scenario_state airi_scenarios_enabled airi_handoff_active airi_pending_generative_execution",
        )
        .lean<LeanConversationBotState>();
      if (
        !latest ||
        !resolveConversationScenariosEnabled(
          latest,
          workspaceBotSettings.defaultScenariosEnabled,
        ) ||
        !canStartUnavailableMessageScenario({
          scenarioState: latest.airi_scenario_state,
          handoffActive: latest.airi_handoff_active,
          pendingGenerativeExecution: latest.airi_pending_generative_execution,
        })
      ) {
        return NextResponse.json({
          status: "ok",
          skipped_unavailable_message_existing_journey: true,
        });
      }
      conv = { ...conv, ...latest };
    }

    let confirmedPaymentScenario: Awaited<
      ReturnType<typeof loadActiveScenarioSnapshot>
    > = null;
    if (params.behaviorBlockedReason) {
      return NextResponse.json({
        status: "ok",
        skipped_customer_behavior: params.behaviorBlockedReason,
      });
    }
    if (isConfirmedPaymentTurn) {
      // Hydration ran earlier. Re-read the owner so an intervening reply,
      // timeout, reconnect, or scenario edit cannot retarget a confirmed sale.
      const latest = await Conversation.findById(conversationId)
        .select(
          "workspaceId channel sourceId airi_scenario_state airi_scenarios_enabled airi_pending_generative_execution",
        )
        .lean<
          NonNullable<LeanConversationBotState> & {
            workspaceId?: string;
            channel?: string;
          }
        >();
      const snapshot = params.confirmedPaymentScenario;
      const pending = normalizeConversationScenarioState(
        latest?.airi_scenario_state,
      );
      const matches = Boolean(
        snapshot &&
          params.triggerEventKind === "payment_detected" &&
          /^confirmed-payment:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            currentMessageId,
          ) &&
          type === "whatsapp" &&
          latest?.channel === "whatsapp" &&
          String(latest.workspaceId) === workspaceId &&
          latest.sourceId === snapshot.sourceId &&
          params.scenarioOverrideId === snapshot.scenarioId &&
          resolveConversationScenariosEnabled(
            latest,
            workspaceBotSettings.defaultScenariosEnabled,
          ) &&
          !latest.airi_pending_generative_execution &&
          pending?.lockedScenarioId === snapshot.scenarioId &&
          pending.currentActionNodeId === snapshot.pendingSourceActionNodeId &&
          pending.pendingConditionNodeId === snapshot.pendingConditionNodeId &&
          pending.pendingSourceActionNodeId ===
            snapshot.pendingSourceActionNodeId &&
          pending.pendingLastOutboundMessageId ===
            snapshot.pendingLastOutboundMessageId &&
          normalizeDateIso(pending.pendingStartedAt) ===
            snapshot.pendingStartedAt &&
          normalizeDateIso(pending.pendingScenarioUpdatedAt) ===
            snapshot.scenarioUpdatedAt &&
          normalizeDateIso(snapshot.occurredAt) &&
          new Date(snapshot.occurredAt).getTime() >=
            new Date(snapshot.pendingStartedAt).getTime(),
      );
      if (matches && snapshot) {
        confirmedPaymentScenario = await loadActiveScenarioSnapshot({
          workspaceId,
          scenarioId: snapshot.scenarioId,
        });
      }
      if (
        !matches ||
        !snapshot ||
        !confirmedPaymentScenario ||
        normalizeDateIso(confirmedPaymentScenario.updatedAt) !==
          snapshot.scenarioUpdatedAt ||
        hasBlockingScenarioRoutingDiagnostics(
          getCompiledScenarioGraph(confirmedPaymentScenario).diagnostics,
        )
      ) {
        logOrchestrationInfo("skipped_confirmed_payment_scenario", {
          reason: "stale_or_unverified_payment_wait",
        });
        return NextResponse.json({
          status: "ok",
          skipped_confirmed_payment_scenario: true,
        });
      }
      conv = { ...conv, ...latest };
      activeGenerativeExecution = null;
    }

    const isBranchReplyTrigger = isScenarioInteractiveReplyEventKind(
      params.triggerEventKind,
    );
    const mention = /\bairi\b/i.test(effectiveInputText);
    const shouldRunGeneralAutoReply =
      !unavailableInboundContent &&
      !recoveredInboundContent &&
      !isConfirmedPaymentTurn &&
      !params.suppressGeneralAutoReply &&
      (isProactiveTrigger ||
        isBranchReplyTrigger ||
        mention ||
        (process.env.AIRI_AUTO_REPLY_MODE || "always") === "always");
    const shouldContinueForAiriPath =
      executionGates.canResolveScenarios ||
      (executionGates.canDeliverAutoReply && shouldRunGeneralAutoReply);

    if (!shouldContinueForAiriPath) {
      logOrchestrationInfo("skipped_should_reply_false", {
        workspaceId,
        mention,
        mode: process.env.AIRI_AUTO_REPLY_MODE || "always",
        autoReplyEnabled: executionGates.canDeliverAutoReply,
        scenariosEnabled: executionGates.canResolveScenarios,
      });
      return NextResponse.json({ status: "ok", skipped: true });
    }

    if (type === "whatsapp") {
      const bookCallTap = await handleWhatsAppBookCallTap({
        payload: params.quickReplyPayload,
        workspaceId,
        conversationId: String(conversation._id),
        contactData: params.whatsAppInfo?.contactData,
      });
      if (bookCallTap) {
        const outbound = await sendAndPersistOutbound({
          ...params,
          content: bookCallTap.confirmationText,
        });
        logOrchestrationInfo("whatsapp_book_call_tap_handled", {
          workspaceId,
          conversationId: String(conversation._id),
          messageId: currentMessageId,
          outboundMessageId: String(outbound._id),
          actionNodeId: bookCallTap.payload.actionNodeId,
          calendarBookingStatus: bookCallTap.eventResult.status,
          rejectionReason: bookCallTap.rejectionReason || null,
        });
        return await finishTurn({
          status: "ok",
          calendar_booking: bookCallTap.eventResult.status,
        });
      }
    }

    // 4. Start Feedback & Context Gathering
    //
    // Scenario dispatch is deterministic and should not wait for the heavier
    // general-reply context path. Load that context later only if no scenario
    // handles the turn.
    const shouldDeferPreRuntimeContextForScenario =
      executionGates.canResolveScenarios;
    const shouldDetectLanguageBeforeScenario =
      !shouldDeferPreRuntimeContextForScenario;
    const shouldLoadPreRuntimeCompanyContext =
      !shouldDeferPreRuntimeContextForScenario;
    const [initialLanguageDecision, initialCompanyContext] =
      await runAutoReplyStage({
        label: "load-pre-runtime-context",
        diagnostics,
        meta: {
          hasNormalizedInputText: Boolean(normalizedInputText),
          chatSourceId: chatDocument?.sourceId
            ? String(chatDocument.sourceId)
            : null,
          scenarioOnlyMode,
          preRuntimeContextDeferred: shouldDeferPreRuntimeContextForScenario,
          loadLanguageDecision: shouldDetectLanguageBeforeScenario,
          loadCompanyContext: shouldLoadPreRuntimeCompanyContext,
        },
        action: async () => {
          await typing.start();
          return Promise.all([
            shouldDetectLanguageBeforeScenario && normalizedInputText
              ? withTimeoutFallback({
                  label: "detectAndUpdateConversationLanguageDecision",
                  promise: detectAndUpdateConversationLanguageDecision(
                    conversationId,
                    normalizedInputText,
                    {
                      workspaceLanguageBias: workspaceBotSettings.languageBias,
                    },
                  ),
                  timeoutMs: PRE_RUNTIME_CONTEXT_TIMEOUT_MS,
                  fallback: null,
                })
              : Promise.resolve(null),
            shouldLoadPreRuntimeCompanyContext
              ? withTimeoutFallback({
                  label: "fetchCompanyContextBySourceId",
                  promise: fetchCompanyContextBySourceId(replySourceId || ""),
                  timeoutMs: PRE_RUNTIME_CONTEXT_TIMEOUT_MS,
                  fallback: {},
                })
              : Promise.resolve({} as CompanyContext),
          ]);
        },
      });
    logTiming("pre_runtime_context_loaded", {
      loadLanguageDecision: shouldDetectLanguageBeforeScenario,
      loadCompanyContext: shouldLoadPreRuntimeCompanyContext,
    });
    let languageDecision = initialLanguageDecision;
    let languageDecisionLoaded = shouldDetectLanguageBeforeScenario;
    let companyContext: CompanyContext = initialCompanyContext;
    let companyContextLoaded = shouldLoadPreRuntimeCompanyContext;
    const ensureLanguageDecision = async () => {
      if (languageDecisionLoaded) return languageDecision;
      languageDecisionLoaded = true;
      if (!normalizedInputText) {
        languageDecision = null;
        return languageDecision;
      }

      languageDecision = await withTimeoutFallback({
        label: "detectAndUpdateConversationLanguageDecision",
        promise: detectAndUpdateConversationLanguageDecision(
          conversationId,
          normalizedInputText,
          {
            workspaceLanguageBias: workspaceBotSettings.languageBias,
          },
        ),
        timeoutMs: PRE_RUNTIME_CONTEXT_TIMEOUT_MS,
        fallback: null,
      });
      return languageDecision;
    };
    const ensureCompanyContext = async () => {
      if (companyContextLoaded) return companyContext;
      companyContextLoaded = true;
      companyContext = await withTimeoutFallback({
        label: "fetchCompanyContextBySourceId",
        promise: fetchCompanyContextBySourceId(replySourceId || ""),
        timeoutMs: PRE_RUNTIME_CONTEXT_TIMEOUT_MS,
        fallback: {},
      });
      return companyContext;
    };

    const resolveCurrentLanguageContext = () => {
      const currentMessageLanguage =
        languageDecision?.currentTurnLanguage || null;
      const recentCustomerLanguage =
        languageDecision?.recentCustomerLanguage ||
        conv?.airi_last_customer_language ||
        null;
      const conversationPreferredLanguage =
        languageDecision?.conversationPreferredLanguage ||
        conv?.preferred_language ||
        null;

      return {
        currentMessageLanguage,
        recentCustomerLanguage,
        conversationPreferredLanguage,
        customerLanguageContext: resolveCustomerReplyLanguageContext({
          latestInboundText: normalizedInputText,
          latestInboundDetectedLanguage: currentMessageLanguage,
          recentCustomerLanguage,
          conversationPreferredLanguage,
          workspaceLanguage: companyContext.airiLanguage,
          workspaceLanguageBias: workspaceBotSettings.languageBias,
        }),
      };
    };
    let {
      currentMessageLanguage,
      recentCustomerLanguage,
      conversationPreferredLanguage,
      customerLanguageContext,
    } = resolveCurrentLanguageContext();
    let customerReplyLanguage = customerLanguageContext.replyLanguage;
    let scenarioTriggerLanguage = customerLanguageContext.inboundLanguage;
    const refreshCustomerLanguageContext = () => {
      const refreshed = resolveCurrentLanguageContext();
      currentMessageLanguage = refreshed.currentMessageLanguage;
      recentCustomerLanguage = refreshed.recentCustomerLanguage;
      conversationPreferredLanguage = refreshed.conversationPreferredLanguage;
      customerLanguageContext = refreshed.customerLanguageContext;
      customerReplyLanguage = refreshed.customerLanguageContext.replyLanguage;
      scenarioTriggerLanguage =
        refreshed.customerLanguageContext.inboundLanguage;
    };
    const ensurePreRuntimeContext = async () => {
      await Promise.all([ensureLanguageDecision(), ensureCompanyContext()]);
      refreshCustomerLanguageContext();
    };
    const dispatchGenerativeAction = async (input: {
      runtime: GenerativeAIAutoReplyRuntime | null;
      activeExecution: ActiveGenerativeAIExecution | null;
      scenarioOriginRuntime?: AiriScenarioRuntimeConfig | null;
      /** Set when the prompt was rejected and the runtime follows Failure. */
      promptIssue?: GenerativeAIPromptIssue | null;
      scenarioBaseState?: unknown;
    }): Promise<Response> => {
      if (
        !(await checkPoint("Pre-Scenario-Generative-AI", {
          preserveScenarioDelivery: true,
        }))
      ) {
        return NextResponse.json({ status: "ok", cancelled: true });
      }

      const generativeAction =
        await resolveGenerativeAIAutoReplyActionAfterContext({
          runtime: input.runtime,
          activeExecution: input.activeExecution,
          promptIssue: input.promptIssue,
          executionContext: {
            workspaceId,
            conversationId: String(conversation._id),
          },
          acceptedAt: (newMessage.date || new Date()).toISOString(),
          ensurePreRuntimeContext,
          readTargetLanguage: () => customerReplyLanguage,
          claimExecution: (execution) =>
            claimGenerativeExecution({
              workspaceId,
              conversationId: String(conversation._id),
              execution,
            }),
        });

      if (generativeAction.kind === "waiting") {
        return await finishTurn({
          status: "ok",
          scenario_generative_waiting: true,
        });
      }

      if (generativeAction.kind === "started") {
        // Silent start: the workflow starts generation after this turn; the
        // customer's next message from us is the result.
        captureTemporalDeferredCommand(generativeAction.deferredCommand);
      } else {
        const outbound = await sendAndPersistOutbound({
          ...params,
          content: generativeAction.content,
          temporalDispatchPolicy: generativeAction.dispatchPolicy,
          ...(input.scenarioOriginRuntime
            ? {
                scenarioOrigin: buildScenarioOutboundOrigin(
                  input.scenarioOriginRuntime,
                ),
              }
            : {}),
        });
        if (
          generativeAction.kind === "failure" &&
          input.scenarioOriginRuntime
        ) {
          // Like a provider failure: the committed state already follows the
          // Failure route, which may end the scenario after this message.
          await completeScenarioOrWarn(
            "complete_scenario_after_generative_failure_failed",
            {
              scenarioRuntime: input.scenarioOriginRuntime,
              baseState: input.scenarioBaseState,
              completionTimestamp: outbound.date || new Date(),
              lastMessageId: String(outbound._id),
            },
          );
        }
      }

      return await finishTurn({
        status: "ok",
        scenario_generative_ai: generativeAction.kind,
      });
    };
    logOrchestrationInfo("reply_language_resolved", {
      latestInboundDetectedLanguage: currentMessageLanguage || null,
      recentCustomerLanguage,
      conversationPreferredLanguage,
      workspaceLanguage: companyContext.airiLanguage || null,
      workspaceLanguageBias: workspaceBotSettings.languageBias,
      currentTurnLanguageSource:
        languageDecision?.currentTurnLanguageSource || null,
      activeLanguageSource: languageDecision?.activeLanguageSource || null,
      triggerLanguage: scenarioTriggerLanguage,
      chosenLanguage: customerReplyLanguage,
      preRuntimeContextDeferred: shouldDeferPreRuntimeContextForScenario,
    });
    logTiming("reply_language_resolved", {
      activeLanguageSource: languageDecision?.activeLanguageSource || null,
      preRuntimeContextDeferred: shouldDeferPreRuntimeContextForScenario,
    });
    if (activeGenerativeExecution) {
      if (!generativeInbound) {
        return await finishTurn({
          status: "ok",
          scenario_generative_waiting: true,
        });
      }
      return dispatchGenerativeAction({
        runtime: null,
        activeExecution: activeGenerativeExecution,
      });
    }
    const scenarioRuntimeStartedAt = Date.now();
    const runtimeChannel = (persistedCurrentMessage?.channel ||
      newMessage.channel ||
      type) as Channel;
    // A tap records what the customer picked, and a Flow reply the form it
    // submitted, before routing, so waits, collectors and generation that
    // follow all read the same pick and answers.
    const tappedScenarioPick = executionGates.canResolveScenarios
      ? await readTappedScenarioPick({
          findTappedScenarioServiceMessage:
            scenarioDependencies.findTappedScenarioServiceMessage,
          workspaceId,
          conversationId,
          quickReplyPayload: params.quickReplyPayload,
          contextMessageId: newMessage.whatsappMeta?.replyToWhatsAppMessageId,
          pickedAt: new Date(),
        }).catch((error: unknown) => {
          logOrchestrationWarn("scenario_pick_lookup_failed", {
            conversationId,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          });
          return null;
        })
      : null;
    const submittedScenarioForm = executionGates.canResolveScenarios
      ? await readSubmittedScenarioForm({
          findSubmittedScenarioForm:
            scenarioDependencies.findSubmittedScenarioForm,
          workspaceId,
          conversationId,
          flowResponseJson: params.whatsAppFlowResponseJson,
          flowName: newMessage.whatsappFlowReply?.flowName,
          contextMessageId: newMessage.whatsappMeta?.replyToWhatsAppMessageId,
          inboundMessageId: currentMessageId,
          submittedAt: new Date(),
        }).catch((error: unknown) => {
          logOrchestrationWarn("scenario_form_lookup_failed", {
            conversationId,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          });
          return null;
        })
      : null;
    if (submittedScenarioForm) {
      logOrchestrationInfo("scenario_form_submitted", {
        conversationId,
        scenarioId: submittedScenarioForm.scenarioId,
        sourceActionNodeId: submittedScenarioForm.submission.sourceActionNodeId,
        answerCount: submittedScenarioForm.submission.fields.length,
      });
    }
    // A shared location a location step routes on this turn, set below.
    let routedScenarioLocation: {
      scenarioId: string;
      entry: ScenarioRoutedLocationEntry;
    } | null = null;
    // Completing a scenario clears its picks, form answers and routed
    // locations; this event's tap, form and location still count in the
    // state that replaces it.
    const withInboundScenarioRecords = (state: unknown): unknown =>
      withRoutedScenarioLocation(
        withSubmittedScenarioForm(
          withTappedScenarioPick(state, tappedScenarioPick),
          submittedScenarioForm,
        ),
        routedScenarioLocation?.scenarioId,
        routedScenarioLocation?.entry ?? null,
      );
    // A form whose reply routes nowhere still counts for later steps; any
    // wait and its timer go on. The write is fenced to the state this turn
    // started from, so it is skipped once anything else changed it.
    const persistUnroutedScenarioForm = async () => {
      const { persistScenarioFormSubmission } = scenarioDependencies;
      if (!submittedScenarioForm || !persistScenarioFormSubmission) return;
      const logFields = {
        conversationId,
        scenarioId: submittedScenarioForm.scenarioId,
        sourceActionNodeId: submittedScenarioForm.submission.sourceActionNodeId,
      };
      const persisted = await persistScenarioFormSubmission({
        conversationId,
        baseState: conv?.airi_scenario_state,
        submitted: submittedScenarioForm,
      }).catch((error: unknown) => {
        logOrchestrationWarn("scenario_form_submission_persist_failed", {
          ...logFields,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
      if (persisted === null) return;
      logOrchestrationInfo(
        persisted
          ? "scenario_form_submission_persisted"
          : "scenario_form_submission_persist_skipped",
        logFields,
      );
    };
    let scenarioStateForResolution: unknown = withInboundScenarioRecords(
      conv?.airi_scenario_state,
    );
    let preResolvedScenarioResolution: AiriScenarioRuntimeResolution | null =
      null;
    let skipScenarioResolutionForPendingInteractiveNoReply = false;
    // Set when an interactive reply is left to ordinary routing. The wait ends
    // only if that routing selects a branch; a miss keeps it and its timer.
    let clearPendingWaitIfInteractiveReplyRoutes = false;
    // The locked scenario's wait still leads to a No-reply follow-up. Only an
    // explicit stop ends that, so a tap on another scenario's button must not.
    let pendingWaitKeepsNoReplyFollowUp = false;
    // Set after a wait removed by a builder edit is released, so the event is
    // handled as if no scenario was locked.
    let pendingWaitReleased = false;
    // WhatsApp intake leaves taps and Flow replies unlabelled; scenario
    // resolution reads their kind from the payload. Asks read it the same
    // way, so a tap is never taken as the words an ask waits for.
    const inboundEventKind = resolveDefaultTriggerEventKind({
      channel: runtimeChannel,
      triggerEventKind: params.triggerEventKind,
      ...normalizeInteractiveTriggerPayloads(params),
    });
    const inboundIsTap = isScenarioInteractiveReplyEventKind(inboundEventKind);
    const inboundMayAnswerAsk =
      !params.scenarioOverrideId &&
      shouldConsumePromptInputAnswer(inboundEventKind);
    // Preparing a delivery selects the next wait before the provider accepts
    // the message. Keep that wait inert until its exact outbound is confirmed.
    // A real location share can still use the existing location rescue route;
    // a synthetic timeout cannot stand in for the customer's share.
    const waitingForOutbound = normalizeConversationScenarioState(
      scenarioStateForResolution,
    );
    if (
      executionGates.canResolveScenarios &&
      !isConfirmedPaymentTurn &&
      isPendingConditionEligibleTrigger(params.triggerEventKind) &&
      waitingForOutbound?.lockedScenarioId &&
      waitingForOutbound.pendingConditionNodeId &&
      waitingForOutbound.pendingSourceActionNodeId &&
      waitingForOutbound.pendingStartedAt
    ) {
      const outboundMessageId =
        waitingForOutbound.pendingLastOutboundMessageId?.trim();
      const confirmedOutbound = outboundMessageId
        ? await findLatestScenarioActionOutbound({
            workspaceId,
            conversationId,
            scenarioId: waitingForOutbound.lockedScenarioId,
            actionNodeId: waitingForOutbound.pendingSourceActionNodeId,
            outboundMessageId,
          })
        : null;
      let canRescueIncomingLocation = false;
      if (
        !confirmedOutbound &&
        !isScenarioTimeoutTurn &&
        isPendingAnswerMatchTextEvent(params.triggerEventKind) &&
        readTurnSharedLocation(newMessage) &&
        scenarioDependencies.recordScenarioLocationDecision &&
        scenarioDependencies.loadBusinessLocations
      ) {
        const pendingScenario = await loadActiveScenarioSnapshot({
          workspaceId,
          scenarioId: waitingForOutbound.lockedScenarioId,
        });
        const sourceAction = pendingScenario
          ? getCompiledScenarioGraph(pendingScenario).nodesById.get(
              waitingForOutbound.pendingSourceActionNodeId,
            )
          : null;
        const outcomes = normalizeScenarioActionOutcomes(
          sourceAction?.data.kind === "action"
            ? sourceAction.data.actionOutcomes
            : undefined,
        );
        canRescueIncomingLocation =
          outcomes.status === "supported" &&
          Boolean(outcomes.value.locationRoutes);
      }
      if (!confirmedOutbound && !canRescueIncomingLocation) {
        logOrchestrationInfo("skipped_pending_outbound_unconfirmed", {
          workspaceId,
          conversationId,
          messageId: currentMessageId,
          scenarioId: waitingForOutbound.lockedScenarioId,
          sourceActionNodeId: waitingForOutbound.pendingSourceActionNodeId,
          outboundMessageId: outboundMessageId || null,
        });
        return await finishTurn({
          status: "ok",
          skipped_pending_outbound_unconfirmed: true,
        });
      }
    }
    // An ask past its wait period stops holding the conversation: the
    // customer's next message is handled as if nothing was waiting, and a tap
    // on the ask starts it afresh.
    const expiredPromptInputAsk =
      executionGates.canResolveScenarios &&
      !params.scenarioOverrideId &&
      !isConfirmedPaymentTurn &&
      (inboundMayAnswerAsk || inboundIsTap)
        ? readExpiredScenarioPromptInputAsk(scenarioStateForResolution)
        : null;
    if (expiredPromptInputAsk) {
      const expiredState = normalizeConversationScenarioState(
        scenarioStateForResolution,
      );
      const releaseLogFields = {
        workspaceId,
        conversationId: String(conversation._id),
        messageId: currentMessageId,
        scenarioId: expiredPromptInputAsk.scenarioId,
        sourceActionNodeId: expiredPromptInputAsk.sourceActionNodeId,
      };
      const released = await completeLockedScenarioAndPersist({
        conversationId: String(conversation._id),
        baseState: scenarioStateForResolution,
        scenarioId: expiredPromptInputAsk.scenarioId,
        scenarioName: expiredState?.lockedScenarioName?.trim() || "Scenario",
        completionTimestamp: newMessage.date || new Date(),
        lastActionNodeId: expiredPromptInputAsk.sourceActionNodeId,
        lastMessageId: currentMessageId,
        // An armed wait fences the release against a timer turn.
        expectedPendingState: readExpectedPendingState(expiredState),
      }).catch((error) => {
        logOrchestrationWarn("release_expired_prompt_input_ask_failed", {
          ...releaseLogFields,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
      if (!released?.persisted) {
        // The conversation changed before the ask was released; routing on
        // the stale state could replay the ask.
        logOrchestrationInfo(
          "skipped_stale_expired_prompt_input_ask",
          releaseLogFields,
        );
        return await finishTurn({
          status: "ok",
          skipped_stale_pending_wait: true,
        });
      }
      logOrchestrationInfo(
        "released_expired_prompt_input_ask",
        releaseLogFields,
      );
      scenarioStateForResolution = withInboundScenarioRecords(released.state);
    }
    const pendingScenarioState = normalizeConversationScenarioState(
      scenarioStateForResolution,
    );
    // A share the locked scenario already decided, from another turn, is
    // never handled again, wherever the conversation has moved since.
    const decidedTurnShare = executionGates.canResolveScenarios
      ? readTurnSharedLocation(newMessage)
      : null;
    if (
      decidedTurnShare &&
      readScenarioRoutedLocations(
        scenarioStateForResolution,
        pendingScenarioState?.lockedScenarioId,
      ).some((entry) => entry.inboundMessageId === decidedTurnShare.messageId)
    ) {
      logOrchestrationInfo("skipped_decided_scenario_location", {
        workspaceId,
        conversationId,
        messageId: currentMessageId,
        scenarioId: pendingScenarioState?.lockedScenarioId ?? null,
      });
      return await finishTurn({
        status: "ok",
        skipped_decided_scenario_location: true,
      });
    }
    // A message that asks for details takes the customer's words itself, and
    // a buttons, list or carousel ask also its tap; its No reply wait only
    // counts quiet.
    const awaitingPromptInputAsk = readAwaitingScenarioPromptInputAsk(
      scenarioStateForResolution,
    );
    const pendingWaitBelongsToAwaitingAsk = Boolean(
      pendingScenarioState?.pendingSourceActionNodeId &&
        awaitingPromptInputAsk?.sourceActionNodeId ===
          pendingScenarioState.pendingSourceActionNodeId &&
        (inboundMayAnswerAsk ||
          (awaitingPromptInputAsk.followsChoice && inboundIsTap)),
    );
    const shouldPreloadPendingScenario = Boolean(
      executionGates.canResolveScenarios &&
        pendingScenarioState?.lockedScenarioId &&
        pendingScenarioState.pendingConditionNodeId &&
        pendingScenarioState.pendingSourceActionNodeId &&
        isPendingConditionEligibleTrigger(params.triggerEventKind),
    );
    const preloadedPendingScenario =
      confirmedPaymentScenario ??
      (shouldPreloadPendingScenario && pendingScenarioState?.lockedScenarioId
        ? await loadActiveScenarioSnapshot({
            workspaceId,
            scenarioId: pendingScenarioState?.lockedScenarioId,
          })
        : null);
    const preloadedPendingGraph = preloadedPendingScenario
      ? getCompiledScenarioGraph(preloadedPendingScenario)
      : null;
    const preloadedPendingGraphHasBlockingDiagnostics = preloadedPendingGraph
      ? hasBlockingScenarioRoutingDiagnostics(preloadedPendingGraph.diagnostics)
      : false;
    if (preloadedPendingGraphHasBlockingDiagnostics) {
      skipScenarioResolutionForPendingInteractiveNoReply = true;
    }
    let pendingWaitClaimedByLocation = false;
    if (
      executionGates.canResolveScenarios &&
      !preResolvedScenarioResolution &&
      !pendingWaitBelongsToAwaitingAsk &&
      pendingScenarioState?.lockedScenarioId &&
      pendingScenarioState.pendingConditionNodeId &&
      pendingScenarioState.pendingSourceActionNodeId &&
      isPendingConditionEligibleTrigger(params.triggerEventKind) &&
      !preloadedPendingGraphHasBlockingDiagnostics
    ) {
      const pendingScenario =
        preloadedPendingScenario ??
        (await loadActiveScenarioSnapshot({
          workspaceId,
          scenarioId: pendingScenarioState.lockedScenarioId,
        }));

      if (pendingScenario) {
        const pendingGraph =
          preloadedPendingGraph ?? getCompiledScenarioGraph(pendingScenario);
        const pendingWait = resolvePendingPostActionWait({
          graph: pendingGraph,
          conditionNodeId: pendingScenarioState.pendingConditionNodeId,
        });
        pendingWaitKeepsNoReplyFollowUp =
          pendingWait.status === "waiting" && pendingWait.hasNoReplyBranch;
        const pendingGraphHasBlockingDiagnostics =
          pendingWait.status === "blocked";
        if (pendingGraphHasBlockingDiagnostics) {
          skipScenarioResolutionForPendingInteractiveNoReply = true;
        }
        const pendingConditionNode =
          pendingWait.status === "waiting" ? pendingWait.conditionNode : null;
        const pendingSourceActionId =
          typeof pendingScenarioState.pendingSourceActionNodeId === "string"
            ? pendingScenarioState.pendingSourceActionNodeId.trim()
            : "";
        const pendingSourceActionNode =
          !pendingGraphHasBlockingDiagnostics && pendingSourceActionId
            ? pendingGraph.nodesById.get(pendingSourceActionId)
            : null;
        const pendingActionOutcomes = normalizeScenarioActionOutcomes(
          pendingSourceActionNode?.data.kind === "action"
            ? pendingSourceActionNode.data.actionOutcomes
            : undefined,
        );
        const pendingLockedScenarioId = pendingScenarioState.lockedScenarioId;
        const pendingLocationRoutes =
          pendingActionOutcomes.status === "supported"
            ? (pendingActionOutcomes.value.locationRoutes ?? null)
            : null;
        const isTimerTurnEvent =
          isScenarioTimeoutTurn ||
          params.triggerEventKind ===
            SCENARIO_TRIGGER_EVENT_KIND.noHumanReplyTimeout;
        // A location shared while a location step waits is decided before
        // answer rules and Any reply, and is never read as typed text: the
        // turn's own share, else one a merged or superseded turn left behind.
        const pendingLocationShare =
          pendingLocationRoutes &&
          pendingConditionNode?.data.kind === "logic" &&
          scenarioDependencies.recordScenarioLocationDecision &&
          !isConfirmedPaymentTurn &&
          (isTimerTurnEvent ||
            isPendingAnswerMatchTextEvent(params.triggerEventKind))
            ? await readPendingScenarioLocationShare({
                ports: scenarioDependencies,
                workspaceId,
                conversationId,
                scenarioState: scenarioStateForResolution,
                scenarioId: pendingLockedScenarioId,
                waitStartedAt: pendingScenarioState.pendingStartedAt,
                routing: pendingLocationRoutes,
                newMessage,
                isTimerTurn: isTimerTurnEvent,
                now: new Date(),
              })
            : null;
        const pendingLocationLogFields = {
          workspaceId,
          conversationId,
          messageId: currentMessageId,
          scenarioId: pendingLockedScenarioId,
          sourceActionNodeId: pendingSourceActionId,
        };
        if (pendingLocationShare?.kind === "stale_turn_share") {
          // A retried turn, or a share older than one already decided.
          logOrchestrationInfo("skipped_decided_scenario_location", {
            ...pendingLocationLogFields,
            sharedMessageId: pendingLocationShare.messageId,
          });
          return await finishTurn({
            status: "ok",
            skipped_decided_scenario_location: true,
          });
        }
        const pendingLocationDecided =
          pendingLocationShare?.kind === "decided"
            ? pendingLocationShare
            : null;
        // Records a decided share while the wait that decided it still holds.
        const recordPendingScenarioLocation = async (
          entry: ScenarioRoutedLocationEntry,
        ): Promise<boolean> => {
          const expected = readExpectedPendingState(pendingScenarioState);
          if (
            !expected ||
            !scenarioDependencies.recordScenarioLocationDecision
          ) {
            return false;
          }
          const recorded =
            await scenarioDependencies.recordScenarioLocationDecision({
              conversationId,
              baseState: scenarioStateForResolution,
              entry,
              expectedPendingState: {
                scenarioId: pendingLockedScenarioId,
                ...expected,
              },
            });
          if (recorded.persisted) {
            routedScenarioLocation = {
              scenarioId: pendingLockedScenarioId,
              entry,
            };
            scenarioStateForResolution = recorded.state;
          }
          return recorded.persisted;
        };
        const sendNothingForUnroutedLocation = async (
          entry: ScenarioRoutedLocationEntry,
        ) => {
          const recorded = await recordPendingScenarioLocation(entry);
          return await finishTurn(
            recorded
              ? { status: "ok", skipped_unrouted_scenario_location: true }
              : { status: "ok", skipped_stale_pending_wait: true },
          );
        };
        const logPendingLocationDecision = (
          entry: ScenarioRoutedLocationEntry,
          share: { source: string; hasReplyContext: boolean },
        ) =>
          logOrchestrationInfo(
            entry.outcome === "unrouted"
              ? "scenario_location_unrouted"
              : "scenario_location_routed",
            {
              ...pendingLocationLogFields,
              outcome: entry.outcome,
              routeId: entry.routeId ?? null,
              officeKey: entry.office?.key ?? null,
              distanceBucket: bucketScenarioLocationDistance(
                entry.distanceMeters,
              ),
              source: share.source,
              hasReplyContext: share.hasReplyContext,
              reason: entry.reason ?? null,
            },
          );
        let pendingLocationClaim: {
          nextActionNode: NonNullable<
            ReturnType<typeof resolveFirstReachableActionFromNode>
          >;
          claimState: unknown;
          continuation: AiriScenarioRuntimeResolution;
        } | null = null;
        // Answer rules read the customer's own words, without the display
        // text of a share this turn decided.
        let pendingAnswerInputText = effectiveInputText;
        if (pendingLocationDecided) {
          const { share, source, decision } = pendingLocationDecided;
          const logShare = { source, hasReplyContext: share.hasReplyContext };
          const locationTarget = resolveScenarioLocationRouteTarget({
            graph: pendingGraph,
            conditionNodeId: pendingScenarioState.pendingConditionNodeId,
            decision,
            conversation,
            channel: runtimeChannel,
          });
          let unroutedReason: string | null =
            locationTarget.status === "unroutable"
              ? locationTarget.reason
              : null;
          if (locationTarget.status === "routed") {
            const routedEntry = buildScenarioRoutedLocationEntry({
              sourceActionNodeId: pendingSourceActionId,
              share,
              source,
              decision: locationTarget.decision,
              decidedAt: new Date(),
            });
            const claimState = withRoutedScenarioLocation(
              {
                ...(pendingScenarioState || {}),
                currentActionNodeId: locationTarget.nextActionNode.id,
              },
              pendingLockedScenarioId,
              routedEntry,
            );
            // The routed step is built before the wait is claimed, so a step
            // that can't run never ends the wait or its reminders.
            const continuation = await resolveActiveScenarioRuntime({
              workspaceId,
              conversation,
              channel: runtimeChannel,
              scenarioState: claimState,
              forcedScenarioId: pendingLockedScenarioId,
              forcedActionNodeId: locationTarget.nextActionNode.id,
              triggerEventKind: "post_action_user_reply",
              triggerMessageText: scenarioTriggerMessageText,
              quickReplyPayload: params.quickReplyPayload,
              whatsAppFlowResponseJson: params.whatsAppFlowResponseJson,
              generativeInbound,
              triggerWhatsAppReferral,
              triggerLanguage: scenarioTriggerLanguage,
              skipTriggerMatch: true,
            });
            if (continuation.runtime) {
              logPendingLocationDecision(routedEntry, logShare);
              pendingLocationClaim = {
                nextActionNode: locationTarget.nextActionNode,
                claimState,
                continuation,
              };
              pendingWaitClaimedByLocation = true;
              routedScenarioLocation = {
                scenarioId: pendingLockedScenarioId,
                entry: routedEntry,
              };
              scenarioStateForResolution = withInboundScenarioRecords(
                scenarioStateForResolution,
              );
            } else {
              unroutedReason = "step_not_built";
            }
          }
          if (!pendingLocationClaim) {
            const unroutedEntry = buildScenarioRoutedLocationEntry({
              sourceActionNodeId: pendingSourceActionId,
              share,
              source,
              decision: locationTarget.decision,
              unroutedReason: unroutedReason ?? "step_not_built",
              decidedAt: new Date(),
            });
            logPendingLocationDecision(unroutedEntry, logShare);
            pendingAnswerInputText = removeSharedLocationText(
              effectiveInputText,
              share.text,
            );
            // The customer's own share, with nothing typed beside it, sends
            // nothing and the assistant doesn't answer it; the wait and its
            // reminders go on. So does a rescued share.
            if (
              (source === "turn" && !pendingAnswerInputText) ||
              isLocationRescueTurn
            ) {
              return sendNothingForUnroutedLocation(unroutedEntry);
            }
            if (!(await recordPendingScenarioLocation(unroutedEntry))) {
              return await finishTurn({
                status: "ok",
                skipped_stale_pending_wait: true,
              });
            }
            // A timer turn goes on to its reminder, and words the customer
            // typed are handled as themselves.
          }
        }
        // A rescue only routes a share that is still undecided. The wait's
        // No reply reminder keeps its own timer.
        if (isLocationRescueTurn && !pendingLocationClaim) {
          logOrchestrationInfo(
            "skipped_location_rescue",
            pendingLocationLogFields,
          );
          return await finishTurn({
            status: "ok",
            skipped_location_rescue: true,
          });
        }
        const pendingAnswerRulesActive = Boolean(
          !pendingLocationClaim &&
            pendingConditionNode?.data.kind === "logic" &&
            postActionConditionUsesAnswerMatchRules(
              pendingConditionNode.data,
            ) &&
            isPendingAnswerMatchTextEvent(params.triggerEventKind),
        );
        const pendingAnswerMatch =
          pendingAnswerRulesActive &&
          pendingConditionNode?.data.kind === "logic"
            ? await resolvePostActionAnswerMatch({
                messageText: pendingAnswerInputText,
                rules: getNoReplyAnswerMatchRules(pendingConditionNode.data),
                language: scenarioTriggerLanguage,
              })
            : null;
        const pendingAnswerMatchSourceHandle = pendingAnswerMatch
          ? getPostActionAnswerMatchHandleId(pendingAnswerMatch.ruleId)
          : null;
        const pendingAnyReplyEnabled =
          pendingActionOutcomes.status === "supported" &&
          pendingActionOutcomes.value.anyReply?.enabled === true;
        const resolvedPendingEventDisposition =
          pendingConditionNode?.data.kind === "logic"
            ? pendingLocationClaim || pendingAnswerMatchSourceHandle
              ? "user_replied"
              : pendingAnswerRulesActive && !pendingAnyReplyEnabled
                ? "ignore"
                : resolvePendingConditionEventDisposition({
                    triggerEventKind: params.triggerEventKind,
                    conditionNodeId: pendingConditionNode.id,
                    conditionNodeData: pendingConditionNode.data,
                    pendingSourceActionData: pendingSourceActionNode?.data,
                    confirmedPayment: Boolean(confirmedPaymentScenario),
                  })
            : null;
        const claimedScenarioId = pendingScenarioState.lockedScenarioId;
        const claimedConditionNodeId =
          pendingScenarioState.pendingConditionNodeId;
        const claimedSourceActionNodeId =
          pendingScenarioState.pendingSourceActionNodeId;
        // Completes the scenario only while the conversation still holds this
        // exact wait, so a wait written concurrently is left alone.
        const completePendingWait = async (
          failureEvent: string,
          failureContext: Record<string, unknown>,
        ) => {
          const completionResult = await completeLockedScenarioAndPersist({
            conversationId: String(conversation._id),
            baseState: scenarioStateForResolution,
            scenarioId: claimedScenarioId,
            scenarioName:
              typeof pendingScenario.name === "string" &&
              pendingScenario.name.trim()
                ? pendingScenario.name.trim()
                : "Scenario",
            completionTimestamp: newMessage.date || new Date(),
            lastActionNodeId: claimedSourceActionNodeId,
            lastMessageId: currentMessageId,
            expectedPendingState:
              readExpectedPendingState(pendingScenarioState),
          }).catch((error) => {
            logOrchestrationWarn(failureEvent, {
              conversationId: String(conversation._id),
              scenarioId: claimedScenarioId,
              ...failureContext,
              errorMessage:
                error instanceof Error ? error.message : String(error),
            });
            return null;
          });

          if (!completionResult?.persisted) {
            return null;
          }
          scenarioStateForResolution = completionResult.state;
          return completionResult;
        };

        if (resolvedPendingEventDisposition === "interactive_reply") {
          const branchConditionTarget = resolveInteractiveReplyConditionTarget({
            graph: pendingGraph,
            conversation,
            channel: runtimeChannel,
            preferredActionNodeId: pendingSourceActionId,
            triggerEventKind: params.triggerEventKind,
            quickReplyPayload: params.quickReplyPayload,
            whatsAppFlowResponseJson: params.whatsAppFlowResponseJson,
          });

          if (branchConditionTarget) {
            scenarioStateForResolution = await armInteractiveReplyConditionWait(
              {
                baseState: scenarioStateForResolution,
                scenarioId: pendingScenarioState.lockedScenarioId,
                scenarioName: pendingScenario.name,
                sourceActionNodeId: pendingSourceActionId,
                target: branchConditionTarget,
                carriedAnchor:
                  resolvePendingInteractiveOutboundAnchor(pendingScenarioState),
              },
            );
            skipScenarioResolutionForPendingInteractiveNoReply = true;
          } else {
            clearPendingWaitIfInteractiveReplyRoutes = true;
          }
        } else if (
          resolvedPendingEventDisposition === "unowned_interactive_reply"
        ) {
          clearPendingWaitIfInteractiveReplyRoutes = true;
        } else if (resolvedPendingEventDisposition === "ignore") {
          skipScenarioResolutionForPendingInteractiveNoReply = true;
        } else if (
          resolvedPendingEventDisposition === "no_reply_timeout" &&
          pendingWait.status === "waiting" &&
          !pendingWait.hasNoReplyBranch &&
          pendingWait.hasOtherOutcome
        ) {
          // This timer turn was prepared before a builder edit removed the
          // wait's no-reply branch. The wait's other outcomes still apply, so
          // the conversation keeps waiting, now without a timer.
          logOrchestrationInfo("skipped_timeout_without_no_reply_branch", {
            workspaceId,
            conversationId: String(conversation._id),
            messageId: currentMessageId,
            scenarioId: claimedScenarioId,
            conditionNodeId: claimedConditionNodeId,
          });
          return await finishTurn({
            status: "ok",
            skipped_timeout_without_no_reply_branch: true,
          });
        } else if (
          resolvedPendingEventDisposition === "user_replied" ||
          resolvedPendingEventDisposition === "payment_detected" ||
          resolvedPendingEventDisposition === "no_reply_timeout"
        ) {
          const pendingBranchType =
            resolvedPendingEventDisposition === "user_replied"
              ? "user_replied"
              : resolvedPendingEventDisposition === "payment_detected"
                ? "payment_detected"
                : "no_reply_timeout";
          // Both continuation resolvers below replay this event as the trigger.
          const pendingContinuationTrigger = {
            triggerEventKind:
              pendingBranchType === "user_replied"
                ? "post_action_user_reply"
                : pendingBranchType === "payment_detected"
                  ? "payment_detected"
                  : "no_human_reply_timeout",
            triggerMessageText: scenarioTriggerMessageText,
            quickReplyPayload: params.quickReplyPayload,
            whatsAppFlowResponseJson: params.whatsAppFlowResponseJson,
            generativeInbound,
            triggerWhatsAppReferral,
            triggerLanguage: scenarioTriggerLanguage,
            skipTriggerMatch: true,
          } as const;
          // Once a pending branch claims this event, its outcome is
          // authoritative even when the configured target is missing or no
          // longer reachable. Fail closed instead of re-running the ordinary
          // locked-scenario resolver, which could replay the source action.
          preResolvedScenarioResolution = selectScenarioContinuationOutcome();
          const completeClaimedPendingScenario = () =>
            completePendingWait("complete_claimed_pending_scenario_failed", {
              branchType: pendingBranchType,
            });
          // A location route's step was found, and checked, before the claim.
          const pendingTargetNode = pendingLocationClaim
            ? pendingLocationClaim.nextActionNode
            : pendingAnswerMatchSourceHandle
              ? resolvePostActionConditionSourceHandleTarget({
                  graph: pendingGraph,
                  conditionNodeId: pendingScenarioState.pendingConditionNodeId,
                  sourceHandle: pendingAnswerMatchSourceHandle,
                  conversation,
                  channel: runtimeChannel,
                })
              : resolvePostActionConditionBranchTarget({
                  graph: pendingGraph,
                  conditionNodeId: pendingScenarioState.pendingConditionNodeId,
                  branchType: pendingBranchType,
                  conversation,
                  channel: runtimeChannel,
                });

          if (pendingTargetNode?.data.kind === "scenario_link") {
            if (confirmedPaymentScenario) {
              const currentParent = await loadActiveScenarioSnapshot({
                workspaceId,
                scenarioId: claimedScenarioId,
              });
              if (
                !currentParent ||
                normalizeDateIso(currentParent.updatedAt) !==
                  params.confirmedPaymentScenario!.scenarioUpdatedAt
              ) {
                return await finishTurn({
                  status: "ok",
                  skipped_confirmed_payment_scenario: true,
                });
              }
            }
            const childScenarioId =
              typeof pendingTargetNode.data.linkedScenarioId === "string"
                ? pendingTargetNode.data.linkedScenarioId.trim()
                : "";
            if (childScenarioId) {
              const completionResult = await completeClaimedPendingScenario();

              if (completionResult) {
                const childResolution = await resolveActiveScenarioRuntime({
                  workspaceId,
                  conversation,
                  channel: runtimeChannel,
                  scenarioState: scenarioStateForResolution,
                  forcedScenarioId: childScenarioId,
                  ...pendingContinuationTrigger,
                });
                preResolvedScenarioResolution =
                  selectScenarioContinuationOutcome(childResolution);
              }
            } else {
              await completeClaimedPendingScenario();
            }
          } else if (pendingTargetNode) {
            const nextActionNode =
              pendingTargetNode.data.kind === "action"
                ? pendingTargetNode
                : resolveFirstReachableActionFromNode({
                    graph: pendingGraph,
                    startNodeId: pendingTargetNode.id,
                    conversation,
                    channel: runtimeChannel,
                  });

            if (nextActionNode) {
              const isNoReply = pendingBranchType === "no_reply_timeout";
              // Read before the state moves on to the reminder.
              const remindsAwaitingAsk =
                isNoReply &&
                readAwaitingScenarioPromptInputAsk(scenarioStateForResolution)
                  ?.sourceActionNodeId === claimedSourceActionNodeId;
              // A location route's step was already built, with the office
              // it routed to readable by the step; a share this turn decided
              // stays recorded on any other branch.
              scenarioStateForResolution = pendingLocationClaim
                ? pendingLocationClaim.claimState
                : withRoutedScenarioLocation(
                    {
                      ...(pendingScenarioState || {}),
                      currentActionNodeId: nextActionNode.id,
                    },
                    routedScenarioLocation?.scenarioId,
                    routedScenarioLocation?.entry ?? null,
                  );
              const continuationResolution = pendingLocationClaim
                ? pendingLocationClaim.continuation
                : await resolveActiveScenarioRuntime({
                    workspaceId,
                    conversation,
                    channel: runtimeChannel,
                    scenarioState: scenarioStateForResolution,
                    forcedScenarioId: pendingScenarioState.lockedScenarioId,
                    forcedActionNodeId: nextActionNode.id,
                    ...(confirmedPaymentScenario
                      ? {
                          expectedScenarioUpdatedAt:
                            params.confirmedPaymentScenario!.scenarioUpdatedAt,
                        }
                      : {}),
                    ...pendingContinuationTrigger,
                  });
              if (continuationResolution.staleScenarioRevision) {
                return await finishTurn({
                  status: "ok",
                  skipped_confirmed_payment_scenario: true,
                });
              }
              const returnedToAsk = remindsAwaitingAsk
                ? returnToPromptInputAskAfterReminder(
                    continuationResolution.runtime,
                    claimedSourceActionNodeId,
                  )
                : null;
              if (isNoReply && !returnedToAsk) {
                scenarioStateForResolution = closePromptInputAskForNoReply(
                  scenarioStateForResolution,
                  claimedSourceActionNodeId,
                );
              }
              preResolvedScenarioResolution = selectScenarioContinuationOutcome(
                returnedToAsk
                  ? { ...continuationResolution, runtime: returnedToAsk }
                  : continuationResolution,
              );
              if (
                !continuationResolution.runtime &&
                !continuationResolution.lockedScenarioNoMatch &&
                !continuationResolution.lockedScenarioMissing
              ) {
                await completeClaimedPendingScenario();
              }
            } else {
              await completeClaimedPendingScenario();
            }
          } else {
            await completeClaimedPendingScenario();
          }
        } else if (
          pendingWait.status === "removed" &&
          !isConfirmedPaymentTurn
        ) {
          // A builder edit removed this wait, so nothing could end it. Release
          // the conversation, then handle the event as if nothing was waiting.
          const releasedWait = await completePendingWait(
            "release_removed_pending_wait_failed",
            { conditionNodeId: claimedConditionNodeId },
          );
          const releaseLogFields = {
            workspaceId,
            conversationId: String(conversation._id),
            messageId: currentMessageId,
            scenarioId: claimedScenarioId,
            conditionNodeId: claimedConditionNodeId,
            sourceActionNodeId: claimedSourceActionNodeId,
          };
          if (!releasedWait) {
            // The wait changed, or the write failed, before it was released.
            // Routing on the stale state could replay or restart the scenario.
            logOrchestrationInfo(
              "skipped_stale_removed_pending_wait",
              releaseLogFields,
            );
            return await finishTurn({
              status: "ok",
              skipped_stale_pending_wait: true,
            });
          }
          logOrchestrationInfo(
            "released_removed_pending_wait",
            releaseLogFields,
          );
          // A timer turn is not a customer message, so it ends here.
          if (
            isScenarioTimeoutTurn ||
            params.triggerEventKind ===
              SCENARIO_TRIGGER_EVENT_KIND.noHumanReplyTimeout
          ) {
            return await finishTurn({
              status: "ok",
              released_removed_pending_wait: true,
            });
          }
          // Completing the scenario cleared its picks and form answers;
          // this event's tap and form still count, as after finalization.
          scenarioStateForResolution = withInboundScenarioRecords(
            releasedWait.state,
          );
          pendingWaitReleased = true;
        }
      }
    }
    // A rescue whose wait was no longer there has nothing to route.
    if (isLocationRescueTurn && !pendingWaitClaimedByLocation) {
      logOrchestrationInfo("skipped_location_rescue", {
        workspaceId,
        conversationId,
        messageId: currentMessageId,
        scenarioId: pendingScenarioState?.lockedScenarioId ?? null,
      });
      return await finishTurn({
        status: "ok",
        skipped_location_rescue: true,
      });
    }

    if (
      executionGates.canResolveScenarios &&
      !preResolvedScenarioResolution &&
      !skipScenarioResolutionForPendingInteractiveNoReply &&
      !pendingWaitReleased &&
      pendingScenarioState?.lockedScenarioId &&
      pendingScenarioState.currentActionNodeId &&
      isScenarioInteractiveReplyEventKind(params.triggerEventKind)
    ) {
      const lockedScenario = await loadActiveScenarioSnapshot({
        workspaceId,
        scenarioId: pendingScenarioState.lockedScenarioId,
      });

      if (lockedScenario) {
        const lockedGraph = getCompiledScenarioGraph(lockedScenario);
        const branchConditionTarget = resolveInteractiveReplyConditionTarget({
          graph: lockedGraph,
          conversation,
          channel: runtimeChannel,
          preferredActionNodeId: pendingScenarioState.currentActionNodeId,
          triggerEventKind: params.triggerEventKind,
          quickReplyPayload: params.quickReplyPayload,
          whatsAppFlowResponseJson: params.whatsAppFlowResponseJson,
        });

        if (branchConditionTarget) {
          scenarioStateForResolution = await armInteractiveReplyConditionWait({
            baseState: scenarioStateForResolution,
            scenarioId: pendingScenarioState.lockedScenarioId,
            scenarioName: lockedScenario.name,
            sourceActionNodeId: pendingScenarioState.currentActionNodeId,
            target: branchConditionTarget,
            carriedAnchor:
              resolvePendingInteractiveOutboundAnchor(pendingScenarioState),
          });
          skipScenarioResolutionForPendingInteractiveNoReply = true;
        }
      }
    }

    if (isConfirmedPaymentTurn && !preResolvedScenarioResolution) {
      preResolvedScenarioResolution = selectScenarioContinuationOutcome();
    }
    // Words sent while a buttons, list or carousel message waits for them
    // answer that message, which otherwise listens only for taps.
    const awaitingAsk = inboundMayAnswerAsk
      ? readAwaitingScenarioPromptInputAsk(scenarioStateForResolution)
      : null;
    const awaitingPromptInputChoice = awaitingAsk?.followsChoice
      ? awaitingAsk
      : null;
    const scenarioResolution: AiriScenarioRuntimeResolution =
      preResolvedScenarioResolution ??
      (!executionGates.canResolveScenarios ||
      skipScenarioResolutionForPendingInteractiveNoReply
        ? { runtime: null }
        : await runAutoReplyStage({
            label: "resolve-scenario-runtime",
            diagnostics,
            meta: {
              runtimeChannel,
              lockedScenarioId:
                isScenarioStateLocked(scenarioStateForResolution) &&
                scenarioStateForResolution?.lockedScenarioId
                  ? scenarioStateForResolution.lockedScenarioId
                  : null,
            },
            action: () =>
              resolveActiveScenarioRuntime({
                workspaceId,
                conversation,
                channel: runtimeChannel,
                scenarioState: scenarioStateForResolution,
                forcedScenarioId:
                  params.scenarioOverrideId ??
                  awaitingPromptInputChoice?.scenarioId,
                ...(awaitingPromptInputChoice
                  ? {
                      forcedActionNodeId:
                        awaitingPromptInputChoice.sourceActionNodeId,
                    }
                  : {}),
                forcedTriggerNodeId: params.scenarioTriggerNodeId,
                expectedScenarioUpdatedAt: params.behaviorScenarioUpdatedAt,
                skipTriggerMatch:
                  params.skipTriggerMatch || Boolean(awaitingPromptInputChoice),
                triggerEventKind: params.triggerEventKind,
                triggerMessageText: scenarioTriggerMessageText,
                contentIndependentEntryOnly: unavailableInboundContent,
                quickReplyPayload: params.quickReplyPayload,
                whatsAppFlowResponseJson: params.whatsAppFlowResponseJson,
                ...(pendingWaitKeepsNoReplyFollowUp
                  ? { lockedScenarioFollowUpPending: true }
                  : {}),
                ...(submittedScenarioForm
                  ? {
                      whatsAppFlowReplySource: {
                        scenarioId: submittedScenarioForm.scenarioId,
                        actionNodeId:
                          submittedScenarioForm.submission.sourceActionNodeId,
                      },
                    }
                  : {}),
                generativeInbound,
                triggerWhatsAppReferral,
                triggerLanguage: scenarioTriggerLanguage,
              }),
          }));
    if (
      clearPendingWaitIfInteractiveReplyRoutes &&
      scenarioResolution.runtime
    ) {
      const clearedPendingState = {
        ...(pendingScenarioState || {}),
        pendingConditionNodeId: null,
        pendingSourceActionNodeId: null,
        pendingStartedAt: null,
        pendingScenarioUpdatedAt: null,
        pendingLastOutboundMessageId: null,
        pendingLinkedConditionId: null,
        pendingLegacyRouting: null,
      };
      scenarioStateForResolution = await clearPendingConditionStateAndPersist({
        conversationId: String(conversation._id),
        baseState: scenarioStateForResolution,
      }).catch((error) => {
        logOrchestrationWarn(
          "clear_pending_post_action_condition_state_failed",
          {
            conversationId: String(conversation._id),
            scenarioId: pendingScenarioState?.lockedScenarioId,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          },
        );
        return clearedPendingState;
      });
    }
    let scenarioRuntime = scenarioResolution.runtime;
    // A form another scenario sent waited while this one held the
    // conversation; it counts once its own scenario takes the turn.
    if (
      submittedScenarioForm &&
      scenarioRuntime?.scenarioId === submittedScenarioForm.scenarioId
    ) {
      scenarioStateForResolution = recordScenarioFormSubmission(
        scenarioStateForResolution,
        submittedScenarioForm,
      );
    }
    if (scenarioResolution.blockedScenarioAction) {
      logOrchestrationWarn("scenario_action_blocked", {
        workspaceId,
        conversationId: String(conversation._id),
        messageId: currentMessageId,
        durationMs: Date.now() - scenarioRuntimeStartedAt,
        reason: scenarioResolution.blockedScenarioAction.reason,
        scenarioId: scenarioResolution.blockedScenarioAction.scenarioId,
        actionNodeId: scenarioResolution.blockedScenarioAction.actionNodeId,
      });
      return await finishTurn({
        status: "ok",
        skipped_scenario_action:
          scenarioResolution.blockedScenarioAction.reason,
      });
    }
    if (
      !scenarioRuntime &&
      scenarioResolution.lockedScenarioNoMatch &&
      (isBranchReplyTrigger ||
        (!params.triggerEventKind &&
          Boolean(
            params.quickReplyPayload?.trim() ||
              params.whatsAppFlowResponseJson?.trim(),
          )))
    ) {
      // A button/Flow miss does not complete the active scenario. Handle it
      // before finalization can reinterpret the reply as a new entry message.
      logOrchestrationInfo("skipped_interactive_reply_no_branch_match", {
        workspaceId,
        conversationId: String(conversation._id),
        messageId: currentMessageId,
        scenarioId: scenarioResolution.lockedScenarioNoMatch.scenarioId,
        actionNodeId: scenarioResolution.lockedScenarioNoMatch.lastActionNodeId,
      });
      await persistUnroutedScenarioForm();
      return await finishTurn({
        status: "ok",
        skipped_interactive_reply_no_branch_match: true,
      });
    }
    let promptInputStopWithoutReply = false;
    let promptInputUntapped: ScenarioPromptInputUntapped | null = null;
    // Every template consumer reads answers and picks through these scoped
    // readers: both belong only to the scenario that recorded them.
    const readScenarioPromptInputValues = (
      runtime: AiriScenarioRuntimeConfig | null | undefined,
    ) =>
      readCollectedPromptInputValues(
        scenarioStateForResolution,
        runtime?.scenarioId,
      );
    const readScenarioTemplateMemory = (
      runtime: AiriScenarioRuntimeConfig | null | undefined,
      pickedFrom?: string | null,
    ) => ({
      promptInputs: readScenarioPromptInputValues(runtime),
      pickedOption: readScenarioPickedOption(scenarioStateForResolution, {
        scenarioId: runtime?.scenarioId,
        sourceActionNodeId: pickedFrom,
      }),
      formAnswers: readScenarioFormAnswerTemplateValues(
        readScenarioFormSubmissions(
          scenarioStateForResolution,
          runtime?.scenarioId,
        ),
        runtime?.formAnswerFields,
      ),
      routedOffice: readScenarioRoutedOffice(
        scenarioStateForResolution,
        runtime?.scenarioId,
      ),
    });
    // Resolve a Generative AI prompt before the turn commits to the action.
    // Only a compatible input freezes a prompt; waiting and guidance turns
    // need none, so a missing answer cannot pre-empt their messages.
    let generativeTurn: {
      runtime: GenerativeAIAutoReplyRuntime | null;
      promptIssue: GenerativeAIPromptIssue | null;
    } | null = null;
    // Before a paid generation: the node's daily limit for this conversation,
    // then a light-model check of the customer's words. An unavailable count
    // or check lets the generation go ahead.
    const findGenerativeAICustomerIssue = async (input: {
      scenarioId: string;
      actionNodeId: string;
      config: GenerativeAIActionConfig;
      parts: GenerativeAICustomerTextPart[];
    }): Promise<GenerativeAIPromptIssue | null> => {
      const safety = readGenerativeAISafety(input.config);
      const logFields = {
        conversationId,
        scenarioId: input.scenarioId,
        actionNodeId: input.actionNodeId,
      };
      if (
        safety.dailyLimit !== null &&
        scenarioDependencies.countGenerativeAIStarts
      ) {
        const started = await scenarioDependencies
          .countGenerativeAIStarts({
            conversationId,
            scenarioId: input.scenarioId,
            actionNodeId: input.actionNodeId,
            since: new Date(Date.now() - GENERATIVE_AI_DAILY_LIMIT_WINDOW_MS),
          })
          .catch((error: unknown) => {
            logOrchestrationWarn("scenario_generative_start_count_failed", {
              ...logFields,
              errorMessage:
                error instanceof Error ? error.message : String(error),
            });
            return null;
          });
        if (started !== null && started >= safety.dailyLimit) {
          return "daily_limit_reached";
        }
      }
      if (
        !safety.screenCustomerText ||
        input.parts.length === 0 ||
        !scenarioDependencies.screenGenerativeAICustomerText
      ) {
        return null;
      }
      const screening = await scenarioDependencies
        .screenGenerativeAICustomerText({
          workspaceId,
          mode: input.config.mode,
          parts: input.parts,
        })
        .catch(() => null);
      if (!screening) {
        logOrchestrationWarn(
          "scenario_generative_screen_unavailable",
          logFields,
        );
        return null;
      }
      if (!screening.flagged) return null;
      logOrchestrationWarn("scenario_generative_customer_text_flagged", {
        ...logFields,
        reason: screening.reason,
      });
      return "customer_text_flagged";
    };
    const prepareGenerativeTurn = async (
      runtime: AiriScenarioRuntimeConfig,
    ): Promise<NonNullable<typeof generativeTurn>> => {
      const action = runtime.actionGenerativeAI;
      const actionNodeId =
        runtime.selectedActionNodeId || runtime.nextActionNodeId || null;
      if (
        !action ||
        !runtime.scenarioRevisionFingerprint ||
        !actionNodeId ||
        !runtime.actionGenerativeAISuccessTransition ||
        !runtime.actionGenerativeAIFailureTransition
      ) {
        return { runtime: null, promptIssue: null };
      }
      let config = action.config;
      let prompt = action.config.prompt;
      let promptIssue: GenerativeAIPromptIssue | null = null;
      if (action.input.status === "compatible") {
        try {
          // A node that reads a picked option reads that message's pick.
          const memory = readScenarioTemplateMemory(
            runtime,
            action.config.pickedOption?.sourceActionNodeId,
          );
          const picked = applyGenerativeAIPickedOption(
            action.config,
            memory.pickedOption,
          );
          if (picked.issue) {
            promptIssue = picked.issue;
          } else {
            config = picked.config;
            // Answers enter the prompt quoted, as the customer's own words.
            const references = listScenarioAnswerReferences(
              action.config.prompt,
            );
            const rendered = applyScenarioReplyTemplate({
              reply: action.config.prompt,
              channel: type,
              conversation,
              chatDocument,
              whatsAppInfo: params.whatsAppInfo,
              triggerMessage: newMessage,
              ...memory,
              promptInputs: Object.fromEntries(
                Object.entries(memory.promptInputs).map(([key, value]) => [
                  key,
                  quoteGenerativeAICustomerValue(value),
                ]),
              ),
              formAnswers: Object.fromEntries(
                Object.entries(memory.formAnswers).map(([formKey, fields]) => [
                  formKey,
                  Object.fromEntries(
                    Object.entries(fields).map(([fieldKey, value]) => [
                      fieldKey,
                      quoteGenerativeAICustomerValue(value),
                    ]),
                  ),
                ]),
              ),
              // A form the customer never submitted follows Failure.
              requireFormAnswers: true,
              allowEmptyRender: true,
            });
            prompt =
              references.length > 0 && rendered.trim()
                ? `${rendered}\n\n${GENERATIVE_AI_CUSTOMER_VALUES_NOTE}`
                : rendered;
            const request = readGenerativeAIAppendedCustomerText(
              config,
              action.input.input,
            );
            // Collected details by key, then form answers by name.
            const answers: GenerativeAICustomerTextPart[] = [
              ...references.filter((reference) => reference.kind === "input"),
              ...references.filter((reference) => reference.kind === "form"),
            ].flatMap((reference) => {
              const text = readScenarioAnswerReferenceValue(reference, memory);
              return text === null
                ? []
                : [
                    {
                      kind: "answer" as const,
                      label:
                        reference.kind === "input"
                          ? reference.key
                          : labelScenarioAnswerReference(
                              reference,
                              runtime.formAnswerFields,
                            ),
                      text,
                    },
                  ];
            });
            promptIssue =
              findGenerativeAIPromptIssue(
                { ...config, prompt },
                action.input.input,
              ) ??
              (await findGenerativeAICustomerIssue({
                scenarioId: runtime.scenarioId,
                actionNodeId,
                config,
                parts: request
                  ? [
                      ...answers,
                      { kind: "request", label: "message", text: request },
                    ]
                  : answers,
              }));
          }
        } catch (error) {
          if (isScenarioFormAnswerMissingError(error)) {
            promptIssue = "form_answer_missing";
          } else if (isScenarioPromptInputMissingError(error)) {
            promptIssue = "prompt_input_missing";
          } else {
            throw error;
          }
        }
      }
      if (promptIssue) {
        logOrchestrationWarn("scenario_generative_prompt_rejected", {
          scenarioId: runtime.scenarioId,
          actionNodeId,
          reason: promptIssue,
        });
      }
      return {
        promptIssue,
        runtime: {
          workspaceId,
          conversationId,
          scenarioId: runtime.scenarioId,
          scenarioRevisionFingerprint: runtime.scenarioRevisionFingerprint,
          actionNodeId,
          config: { ...config, prompt },
          input: action.input,
          successTransition: runtime.actionGenerativeAISuccessTransition,
          failureTransition: runtime.actionGenerativeAIFailureTransition,
        },
      };
    };
    // A rejected prompt follows Failure before any claim or paid request,
    // exactly as a provider failure would.
    const followGenerativeAIFailure = (
      runtime: AiriScenarioRuntimeConfig,
    ): AiriScenarioRuntimeConfig => ({
      ...runtime,
      nextActionNodeId:
        runtime.actionGenerativeAIFailureTransition?.nextActionNodeId ?? null,
      completesScenario:
        runtime.actionGenerativeAIFailureTransition?.completesScenario ?? true,
    });
    const persistRuntimeScenarioState = (
      runtime: AiriScenarioRuntimeConfig,
      keepPendingWait?: KeptScenarioPendingWait | null,
    ) =>
      persistScenarioState({
        conversationId: String(conversation._id),
        scenarioRuntime: runtime,
        messageId: currentMessageId,
        baseState: scenarioStateForResolution,
        ...(keepPendingWait ? { keepPendingWait } : {}),
      }).catch((error) => {
        if (isScenarioPendingWriteCoordinationError(error)) throw error;
        if (runtime.actionType === "end_scenario") throw error;
        logOrchestrationWarn("persist_scenario_state_failed", {
          conversationId: String(conversation._id),
          scenarioId: runtime.scenarioId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });
    if (
      scenarioResolution.lockedScenarioNoMatch ||
      scenarioResolution.lockedScenarioMissing
    ) {
      scenarioRuntime = await finalizeScenarioResolution({
        conversationId: String(conversation._id),
        scenarioRuntime,
        messageId: currentMessageId,
        baseState: scenarioStateForResolution,
        resolveParams: {
          workspaceId,
          conversation,
          channel: runtimeChannel,
        },
        lockedScenarioNoMatch: scenarioResolution.lockedScenarioNoMatch,
        lockedScenarioMissing: scenarioResolution.lockedScenarioMissing,
      }).catch((error) => {
        if (isScenarioPendingWriteCoordinationError(error)) throw error;
        logOrchestrationWarn("finalize_scenario_state_transition_failed", {
          conversationId: String(conversation._id),
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return scenarioRuntime;
      });
      // Finalization commits its own state and may end the locked scenario
      // and start another. Later writes continue from that committed state,
      // not from the replaced lock and its collected answers.
      try {
        const committed = await Conversation.findById(conversationId)
          .select("airi_scenario_state")
          .lean<LeanConversationBotState>();
        if (committed) {
          scenarioStateForResolution = withInboundScenarioRecords(
            committed.airi_scenario_state ?? null,
          );
        }
      } catch (error) {
        logOrchestrationWarn("reload_finalized_scenario_state_failed", {
          conversationId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (scenarioRuntime) {
      // A tap on a message that also asks for details records the tapped
      // branch; the customer's words then continue on it.
      const choicePlan = planServiceMessagePromptInputChoice({
        runtime: scenarioRuntime,
        scenarioState: scenarioStateForResolution,
      });
      if (choicePlan.type !== "none") {
        scenarioStateForResolution = choicePlan.scenarioState;
      }
      if (choicePlan.type === "hold") {
        scenarioRuntime = choicePlan.runtime;
        promptInputStopWithoutReply = true;
      }
      if (
        !promptInputStopWithoutReply &&
        scenarioRuntime.actionWhatsAppServiceMessage
      ) {
        const promptInputNodeId = scenarioRuntime.selectedActionNodeId;
        const promptInputSourceParts = {
          text: persistedCurrentMessage?.text ?? newMessage.text ?? null,
          audioAnalysis: persistedCurrentMessage?.audioAnalysis ?? null,
          videoAnalysis: persistedCurrentMessage?.videoAnalysis ?? null,
        };
        const promptInputSourceText = buildScenarioPromptInputSourceText(
          promptInputSourceParts,
        );
        const { extractScenarioPromptInputs } = scenarioDependencies;
        const extractPromptInputs: ScenarioPromptInputExtractor | undefined =
          extractScenarioPromptInputs
            ? (input) => extractScenarioPromptInputs({ workspaceId, ...input })
            : undefined;
        const applyPromptInputPlan = async (
          allowExtract: boolean,
        ): Promise<void> => {
          if (!scenarioRuntime?.actionWhatsAppServiceMessage) return;
          const promptInputPlan = await planServiceMessagePromptInputTurn({
            runtime: scenarioRuntime,
            scenarioState: scenarioStateForResolution,
            sourceText: promptInputSourceText,
            triggerEventKind: inboundEventKind,
            allowExtract,
            extract: extractPromptInputs,
          });
          switch (promptInputPlan.type) {
            case "none":
              return;
            case "wait":
              scenarioRuntime = promptInputPlan.runtime;
              scenarioStateForResolution = promptInputPlan.scenarioState;
              return;
            case "hold":
              scenarioRuntime = promptInputPlan.runtime;
              scenarioStateForResolution = promptInputPlan.scenarioState;
              promptInputStopWithoutReply = true;
              promptInputUntapped = promptInputPlan.untapped ?? null;
              return;
            case "stored":
              scenarioRuntime = promptInputPlan.runtime;
              scenarioStateForResolution = promptInputPlan.scenarioState;
              promptInputStopWithoutReply = true;
              return;
            case "resume": {
              const askNodeId = scenarioRuntime.selectedActionNodeId;
              // The reply that completed this ask is the answer the resumed
              // action receives, read exactly as the collector read it.
              const promptInputAnswerText = promptInputPlan.answered
                ? buildScenarioPromptInputAnswerText(promptInputSourceParts)
                : "";
              // A choice ask continues where its tap would have gone.
              const replayChoiceOptionId = promptInputPlan.replayChoiceOptionId;
              const resumedResolution = await resolveActiveScenarioRuntime({
                workspaceId,
                conversation,
                channel: runtimeChannel,
                scenarioState: promptInputPlan.scenarioState,
                forcedScenarioId: params.scenarioOverrideId,
                forcedTriggerNodeId: params.scenarioTriggerNodeId,
                expectedScenarioUpdatedAt: params.behaviorScenarioUpdatedAt,
                skipTriggerMatch: params.skipTriggerMatch,
                triggerEventKind: replayChoiceOptionId
                  ? SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply
                  : params.triggerEventKind,
                triggerMessageText: scenarioTriggerMessageText,
                contentIndependentEntryOnly: unavailableInboundContent,
                quickReplyPayload:
                  replayChoiceOptionId ?? params.quickReplyPayload,
                whatsAppFlowResponseJson: params.whatsAppFlowResponseJson,
                generativeInbound:
                  generativeInbound && promptInputAnswerText
                    ? { ...generativeInbound, promptInputAnswerText }
                    : generativeInbound,
                triggerWhatsAppReferral,
                triggerLanguage: scenarioTriggerLanguage,
              });
              const resumedNodeId =
                resumedResolution.runtime?.selectedActionNodeId;
              if (
                resumedResolution.runtime &&
                resumedNodeId &&
                resumedNodeId !== askNodeId
              ) {
                scenarioRuntime = resumedResolution.runtime;
                scenarioStateForResolution = promptInputPlan.scenarioState;
                return;
              }
              const resend = replayChoiceOptionId
                ? planServiceMessagePromptInputResend({
                    runtime: scenarioRuntime,
                    scenarioState: promptInputPlan.scenarioState,
                  })
                : null;
              if (resend) {
                logOrchestrationInfo("scenario_prompt_input_choice_resent", {
                  workspaceId,
                  conversationId: String(conversation._id),
                  scenarioId: scenarioRuntime.scenarioId,
                  actionNodeId: askNodeId || null,
                });
                scenarioRuntime = resend.runtime;
                scenarioStateForResolution = resend.scenarioState;
                return;
              }
              scenarioRuntime =
                holdServiceMessagePromptInputNode(scenarioRuntime);
              scenarioStateForResolution = promptInputPlan.scenarioState;
              promptInputStopWithoutReply = true;
              return;
            }
            default: {
              const exhaustive: never = promptInputPlan;
              return exhaustive;
            }
          }
        };
        await applyPromptInputPlan(true);
        if (
          !promptInputStopWithoutReply &&
          scenarioRuntime.actionWhatsAppServiceMessage &&
          scenarioRuntime.selectedActionNodeId !== promptInputNodeId
        ) {
          await applyPromptInputPlan(false);
        }
      }
      const flowPromptInputCapture = scenarioRuntime.flowPromptInputCapture;
      if (flowPromptInputCapture) {
        try {
          const mergedPromptInputs = mergePromptInputAnswersIntoScenarioState({
            state: scenarioStateForResolution,
            scenarioId: scenarioRuntime.scenarioId,
            sourceActionNodeId: flowPromptInputCapture.sourceActionNodeId,
            sourcePathNodeIds: scenarioRuntime.selectedPathNodeIds ?? [],
            values: flowPromptInputCapture.values,
          });
          if (mergedPromptInputs) {
            scenarioStateForResolution = mergedPromptInputs;
          }
        } catch (error) {
          // A full set of collected details must not stop the turn that
          // sent the form. Its answers are usually saved as form answers
          // too; the log says whether this reply's were.
          if (!isScenarioPromptInputCapacityError(error)) throw error;
          logOrchestrationWarn("scenario_flow_prompt_inputs_over_capacity", {
            conversationId,
            scenarioId: scenarioRuntime.scenarioId,
            sourceActionNodeId: flowPromptInputCapture.sourceActionNodeId,
            formAnswersCaptured:
              submittedScenarioForm?.scenarioId ===
                scenarioRuntime.scenarioId &&
              submittedScenarioForm.submission.sourceActionNodeId ===
                flowPromptInputCapture.sourceActionNodeId,
          });
        }
      }
      if (scenarioRuntime.actionType === "generative_ai") {
        generativeTurn = await prepareGenerativeTurn(scenarioRuntime);
        if (generativeTurn.promptIssue) {
          scenarioRuntime = followGenerativeAIFailure(scenarioRuntime);
        }
      }
      // Words sent before the tap: the assistant answers words the ask could
      // not use, or the ask nudges once to tap. The ask keeps waiting.
      let untappedReply: "assistant" | "nudge" | null = null;
      if (
        promptInputUntapped === "unrelated" &&
        executionGates.canDeliverAutoReply &&
        shouldRunGeneralAutoReply &&
        !autoReplySuppressedByRuntimeLock
      ) {
        untappedReply = "assistant";
      } else if (promptInputUntapped) {
        const nudgedState = claimPromptInputChoiceNudge({
          runtime: scenarioRuntime,
          scenarioState: scenarioStateForResolution,
        });
        if (nudgedState) {
          scenarioStateForResolution = nudgedState;
          untappedReply = "nudge";
        }
      }
      if (
        unavailableInboundContent &&
        !(await checkPoint("Pre-Unavailable-Scenario-Commit", {
          preserveScenarioDelivery: false,
        }))
      ) {
        return NextResponse.json({ status: "ok", cancelled: true });
      }
      await persistRuntimeScenarioState(
        scenarioRuntime,
        promptInputStopWithoutReply
          ? readKeptPromptInputWait(scenarioStateForResolution, scenarioRuntime)
          : null,
      );
      const promptInputLogFields = {
        workspaceId,
        conversationId: String(conversation._id),
        messageId: currentMessageId,
        scenarioId: scenarioRuntime.scenarioId,
        actionNodeId: scenarioRuntime.selectedActionNodeId || null,
      };
      if (untappedReply === "assistant") {
        logOrchestrationInfo(
          "scenario_prompt_input_left_to_assistant",
          promptInputLogFields,
        );
        scenarioRuntime = null;
        promptInputStopWithoutReply = false;
      } else if (untappedReply === "nudge") {
        if (
          !(await checkPoint("Pre-Scenario-Prompt-Input-Nudge", {
            preserveScenarioDelivery: true,
          }))
        ) {
          return NextResponse.json({ status: "ok", cancelled: true });
        }
        if (evaluateDelivery(undefined, { scenarioDelivery: true }).allowSend) {
          await ensurePreRuntimeContext();
          // Not scenario-origin: the ask's message stays its wait's anchor.
          await sendAndPersistOutbound({
            ...params,
            content: resolvePromptInputChoiceNudge(customerReplyLanguage),
          });
          logOrchestrationInfo(
            "scenario_prompt_input_nudged",
            promptInputLogFields,
          );
        }
      }
    }

    const scenarioRuntimeDurationMs = Date.now() - scenarioRuntimeStartedAt;
    logOrchestrationInfo("scenario_runtime_resolved", {
      workspaceId,
      conversationId: String(conversation._id),
      durationMs: scenarioRuntimeDurationMs,
      matched: Boolean(scenarioRuntime),
      hadLockedNoMatch: Boolean(scenarioResolution.lockedScenarioNoMatch),
      hadLockedMissing: Boolean(scenarioResolution.lockedScenarioMissing),
      lockedScenarioId:
        isScenarioStateLocked(conv?.airi_scenario_state) &&
        conv?.airi_scenario_state?.lockedScenarioId
          ? conv.airi_scenario_state.lockedScenarioId
          : null,
    });
    if (scenarioRuntime) {
      logOrchestrationInfo("scenario_runtime_applied", {
        workspaceId,
        conversationId: String(conversation._id),
        scenarioId: scenarioRuntime.scenarioId,
        scenarioName: scenarioRuntime.scenarioName,
        selectedActionNodeId: scenarioRuntime.selectedActionNodeId || null,
        selectedPathNodeIds: scenarioRuntime.selectedPathNodeIds || [],
        selectedBranchNodeIds: scenarioRuntime.selectedBranchNodeIds || [],
      });
    }
    if (promptInputStopWithoutReply && scenarioRuntime) {
      if (scenarioRuntime.completesScenario) {
        await completeScenarioOrWarn(
          "complete_scenario_after_prompt_input_failed",
          {
            scenarioRuntime,
            baseState: scenarioStateForResolution,
            completionTimestamp: newMessage.date || new Date(),
            lastMessageId: currentMessageId,
          },
        );
      }
      return await finishTurn({
        status: "ok",
        scenario_prompt_input_stored: true,
      });
    }
    if (scenarioRuntime?.actionType === "end_scenario") {
      logOrchestrationInfo("scenario_ended", {
        workspaceId,
        conversationId: String(conversation._id),
        scenarioId: scenarioRuntime.scenarioId,
        actionNodeId: scenarioRuntime.selectedActionNodeId || null,
      });
      return await finishTurn({ status: "ok", scenario_ended: true });
    }
    if (scenarioRuntime?.actionType === "generative_ai") {
      if (!generativeTurn) {
        // Finalization already committed this action; record the Failure
        // route now if its prompt cannot be accepted.
        generativeTurn = await prepareGenerativeTurn(scenarioRuntime);
        if (generativeTurn.promptIssue) {
          scenarioRuntime = followGenerativeAIFailure(scenarioRuntime);
          await persistRuntimeScenarioState(scenarioRuntime);
        }
      }
      return dispatchGenerativeAction({
        runtime: generativeTurn.runtime,
        activeExecution: null,
        scenarioOriginRuntime: scenarioRuntime,
        promptIssue: generativeTurn.promptIssue,
        scenarioBaseState: scenarioStateForResolution,
      });
    }
    if (scenarioRuntime?.actionType === "whatsapp_template") {
      if (type !== "whatsapp") {
        logOrchestrationInfo("scenario_whatsapp_template_skipped_channel", {
          workspaceId,
          conversationId: String(conversation._id),
          scenarioId: scenarioRuntime.scenarioId,
          channel: type,
        });
        scenarioRuntime = null;
      } else {
        const templateName =
          scenarioRuntime.actionWhatsAppTemplateName?.trim() || "";

        if (!templateName) {
          logOrchestrationInfo(
            "scenario_whatsapp_template_skipped_empty_name",
            {
              workspaceId,
              conversationId: String(conversation._id),
              scenarioId: scenarioRuntime.scenarioId,
              actionNodeId: scenarioRuntime.selectedActionNodeId || null,
            },
          );
          scenarioRuntime = null;
        } else {
          if (
            !(await checkPoint("Pre-Scenario-WhatsApp-Template", {
              preserveScenarioDelivery: true,
            }))
          ) {
            return NextResponse.json({ status: "ok", cancelled: true });
          }

          const templateValues = buildScenarioTemplateValueMap({
            conversation,
            chatDocument,
            whatsAppInfo: params.whatsAppInfo,
            triggerMessage: newMessage,
            actionLinkUrls: scenarioRuntime.actionLinkUrls,
            actionReplyText: scenarioRuntime.actionReplyText,
          });
          const sourceMessageId = String(newMessage._id || "");
          const isBehaviorTemplateTurn =
            sourceMessageId.startsWith("customer-behavior:") ||
            Boolean(
              sourceMessageId.startsWith("scenario-timeout:") &&
                conversation.airi_scenario_state?.behaviorRunId,
            );
          if (isBehaviorTemplateTurn) {
            if (!scenarioDependencies.loadBehaviorTemplateValues)
              throw new Error("Behavior template host unavailable");
            Object.assign(
              templateValues,
              await scenarioDependencies.loadBehaviorTemplateValues({
                workspaceId,
                conversationId: String(conversation._id),
                scenarioId: scenarioRuntime.scenarioId || undefined,
                sourceMessageId,
                behaviorRunId: conversation.airi_scenario_state?.behaviorRunId,
              }),
            );
          }
          const nodeTemplateLanguage =
            scenarioRuntime.actionWhatsAppTemplateLanguage?.trim() || "";
          const nodeTemplateComponents =
            scenarioRuntime.actionWhatsAppTemplateComponents;
          const templateLanguageResolution =
            await resolveScenarioTemplateLanguage({
              workspaceId,
              sourceId: replySourceId,
              templateName,
              requestedLanguage: customerReplyLanguage,
              workspaceDefaultLanguage: companyContext.airiLanguage,
              nodeConfiguredLanguage: nodeTemplateLanguage,
              nodeTemplateComponents,
            });
          const languageCode =
            templateLanguageResolution.resolvedLanguage || "en";
          const resolvedTemplateComponentsDefinition =
            templateLanguageResolution.templateComponents ||
            scenarioRuntime.actionWhatsAppTemplateComponents;
          const templateFlowConfig = scenarioRuntime.actionFlowConfig;
          const templateFlowIdentity = resolveSendableWhatsAppFlowIdentity({
            flowConfig: templateFlowConfig,
            legacyFlowId: scenarioRuntime.actionReplyCtaFlowId,
          });
          const templateLinkedFlowId =
            templateFlowIdentity?.kind === "flow_id"
              ? templateFlowIdentity.flow_id
              : "";
          const templateLinkedFlowName =
            templateFlowIdentity?.kind === "flow_name"
              ? templateFlowIdentity.flow_name
              : "";
          // The template's one FLOW button when the step links no Flow, so its
          // reply can be traced back to this send. Behaviour runs send through
          // a transport that carries no Flow, so they record none.
          const templateFlowButton =
            !templateFlowIdentity && !isBehaviorTemplateTurn
              ? readSingleWhatsAppTemplateFlowButton(
                  resolvedTemplateComponentsDefinition,
                )
              : null;
          const templateButtonFlowId = templateFlowButton?.flowId ?? null;
          const templateStructuredToken = buildFlowEndpointTokenFromConfig(
            templateFlowConfig ?? null,
          );
          // Minted here so the token sent is the token stored.
          const templateScenarioFlowToken =
            templateFlowIdentity || templateButtonFlowId
              ? (templateFlowIdentity && templateStructuredToken) ||
                `flow_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`
              : undefined;
          assertScenarioTemplateFlowComponents({
            templateName,
            templateComponents: resolvedTemplateComponentsDefinition,
            linkedFlowId: templateLinkedFlowId,
            linkedFlowName: templateLinkedFlowName,
          });
          const templateComponents = buildScenarioTemplateComponents({
            templateComponents: resolvedTemplateComponentsDefinition,
            values: templateValues,
            bindings: scenarioRuntime.actionWhatsAppTemplateBindings,
            promptInputs: readScenarioPromptInputValues(scenarioRuntime),
            flowToken: templateScenarioFlowToken,
            flowActionData: resolveWhatsAppFlowActionData(templateFlowConfig),
            actionNodeId:
              scenarioRuntime.selectedActionNodeId ||
              scenarioRuntime.nextActionNodeId ||
              undefined,
            nodeTemplateComponents,
            templateButtonIds: scenarioRuntime.actionWhatsAppTemplateButtonIds,
          });
          logOrchestrationInfo("scenario_template_localization_resolved", {
            workspaceId,
            conversationId: String(conversation._id),
            scenarioId: scenarioRuntime.scenarioId,
            templateName,
            requestedLanguage: templateLanguageResolution.requestedLanguage,
            resolvedLanguage: languageCode,
            fallbackTier: templateLanguageResolution.fallbackTier,
            matchedVariant: templateLanguageResolution.matchedVariant,
            availableLanguages: templateLanguageResolution.availableLanguages,
          });
          if (!templateLanguageResolution.matchedVariant) {
            logOrchestrationWarn("scenario_template_variant_fallback_used", {
              workspaceId,
              conversationId: String(conversation._id),
              scenarioId: scenarioRuntime.scenarioId,
              templateName,
              requestedLanguage: templateLanguageResolution.requestedLanguage,
              resolvedLanguage: languageCode,
              fallbackTier: templateLanguageResolution.fallbackTier,
            });
          }
          const templateDeliveryGate = evaluateDelivery(undefined, {
            scenarioDelivery: true,
          });
          if (!templateDeliveryGate.allowSend) {
            logOrchestrationInfo("scenario_template_suppressed", {
              workspaceId,
              conversationId: String(conversation._id),
              messageId: currentMessageId,
              reason: templateDeliveryGate.reason,
              rolloutBucket: templateDeliveryGate.rolloutBucket,
              rolloutPercentage: templateDeliveryGate.rolloutPercentage,
            });
            return await finishTurn({
              status: "ok",
              scenario_template_suppressed: true,
              deliveryReason: templateDeliveryGate.reason,
            });
          }

          const templateFlowCtaLabel = (
            scenarioRuntime.actionReplyCtaLabel || "Open flow"
          )
            .trim()
            .slice(0, 30);
          const templateFlowActionType =
            resolveWhatsAppFlowActionType(templateFlowConfig);
          const templateFlowProviderSource = resolveWhatsAppFlowProviderSource({
            flowConfig: templateFlowConfig,
          });
          const templateFormResponseFields =
            scenarioRuntime.actionFormResponseFields;
          const whatsappFlowCtaForTemplate = templateFlowIdentity
            ? {
                ...(templateLinkedFlowId
                  ? { flowId: templateLinkedFlowId }
                  : {}),
                ...(templateLinkedFlowName
                  ? { flowName: templateLinkedFlowName }
                  : {}),
                ...(templateFlowProviderSource?.sourceId
                  ? {
                      managedSourceId: templateFlowProviderSource.sourceId,
                      managedWabaId: templateFlowProviderSource.wabaId,
                    }
                  : {}),
                flowToken: templateScenarioFlowToken,
                flowCta: templateFlowCtaLabel || "Open flow",
                responseFieldMetadata:
                  templateFormResponseFields?.fields ?? null,
                ...(templateFlowActionType === "data_exchange"
                  ? { flowActionType: templateFlowActionType }
                  : {}),
                scenarioId: scenarioRuntime.scenarioId,
                scenarioName: scenarioRuntime.scenarioName,
                actionNodeId: scenarioRuntime.selectedActionNodeId || undefined,
              }
            : templateButtonFlowId
              ? {
                  flowId: templateButtonFlowId,
                  flowToken: templateScenarioFlowToken,
                  // The label the customer tapped, which titles the reply.
                  flowCta:
                    templateFlowButton?.text.slice(0, 30) ||
                    templateFlowCtaLabel ||
                    "Open flow",
                  // The step's saved form describes the send only when it
                  // was read from the Flow this button opens.
                  responseFieldMetadata:
                    templateFormResponseFields?.flowId === templateButtonFlowId
                      ? templateFormResponseFields.fields
                      : null,
                  scenarioId: scenarioRuntime.scenarioId,
                  scenarioName: scenarioRuntime.scenarioName,
                  actionNodeId:
                    scenarioRuntime.selectedActionNodeId || undefined,
                }
              : undefined;

          const outbound = await sendAndPersistOutbound({
            ...params,
            content: `[Template: ${templateName}]`,
            whatsappTemplate: {
              name: templateName,
              languageCode,
              components: templateComponents,
              headerMediaSource: "template",
            },
            whatsappFlowCta: whatsappFlowCtaForTemplate,
            scenarioOrigin: buildScenarioOutboundOrigin(scenarioRuntime),
            scenarioAttachments: scenarioRuntime.actionAttachments,
            scenarioImageUrls: scenarioRuntime.actionImageUrls,
          });
          await clearSuppressedStateAfterDelivery(
            String(conversation._id),
          ).catch((error) => {
            logOrchestrationWarn(
              "clear_suppression_state_after_template_failed",
              {
                conversationId: String(conversation._id),
                errorMessage:
                  error instanceof Error ? error.message : String(error),
              },
            );
          });

          logOrchestrationInfo("scenario_whatsapp_template_sent", {
            workspaceId,
            conversationId: String(conversation._id),
            scenarioId: scenarioRuntime.scenarioId,
            templateName,
            languageCode,
          });
          await completeScenarioOrWarn(
            "complete_scenario_after_template_failed",
            {
              scenarioRuntime,
              baseState: scenarioStateForResolution,
              completionTimestamp: outbound.date || new Date(),
              lastMessageId: String(outbound._id),
            },
          );

          return await finishTurn({ status: "ok", scenario_template: true });
        }
      }
    }

    if (scenarioRuntime?.actionType === "assign_human") {
      const conversationId = String(conversation._id);
      const handoffAt = new Date();
      const instructionText = (scenarioRuntime.actionInstruction || "").trim();
      const handoffReason =
        instructionText || "Scenario requested human handoff";
      const handoffSource =
        params.triggerEventKind ===
        SCENARIO_TRIGGER_EVENT_KIND.noHumanReplyTimeout
          ? "scenario_timeout"
          : "scenario_contains";

      let lastDispatchMessageId = currentMessageId;
      if (instructionText) {
        if (
          !(await checkPoint("Pre-Scenario-Assign-Human-Message", {
            preserveScenarioDelivery: true,
          }))
        ) {
          return NextResponse.json({ status: "ok", cancelled: true });
        }

        const renderedContent = applyScenarioReplyTemplate({
          template: undefined,
          reply: instructionText,
          channel: type,
          conversation,
          chatDocument,
          whatsAppInfo: params.whatsAppInfo,
          triggerMessage: newMessage,
          configuredLinks: scenarioRuntime.actionLinkUrls,
          configuredImages: scenarioRuntime.actionImageUrls,
          ...readScenarioTemplateMemory(scenarioRuntime),
        });
        await ensurePreRuntimeContext();
        const ensuredHandoffMessage = await ensureReplyLanguage({
          text: renderedContent,
          targetLanguage: customerReplyLanguage,
          workspaceId,
          elevenlabsAgentId: workspaceBotSettings.elevenlabsAgentId,
        });
        const handoffMessageBody = `Airi: ${ensuredHandoffMessage.text}`;
        const assignHumanDeliveryGate = evaluateDelivery(undefined, {
          scenarioDelivery: true,
        });
        if (!assignHumanDeliveryGate.allowSend) {
          logOrchestrationInfo("scenario_assign_human_message_suppressed", {
            workspaceId,
            conversationId,
            messageId: currentMessageId,
            reason: assignHumanDeliveryGate.reason,
            rolloutBucket: assignHumanDeliveryGate.rolloutBucket,
            rolloutPercentage: assignHumanDeliveryGate.rolloutPercentage,
          });
        } else {
          try {
            const outboundHandoff = await sendAndPersistOutbound({
              ...params,
              content: handoffMessageBody,
              scenarioOrigin: buildScenarioOutboundOrigin(scenarioRuntime),
              scenarioAttachments: scenarioRuntime.actionAttachments,
              scenarioImageUrls: scenarioRuntime.actionImageUrls,
            });
            lastDispatchMessageId = String(outboundHandoff._id);
            await clearSuppressedStateAfterDelivery(
              String(conversation._id),
            ).catch((error) => {
              logOrchestrationWarn(
                "clear_suppression_state_after_handoff_message_failed",
                {
                  conversationId: String(conversation._id),
                  errorMessage:
                    error instanceof Error ? error.message : String(error),
                },
              );
            });
            logOrchestrationInfo("scenario_assign_human_message_sent", {
              workspaceId,
              conversationId,
              scenarioId: scenarioRuntime.scenarioId,
            });
          } catch (error) {
            logOrchestrationWarn("scenario_assign_human_message_send_failed", {
              conversationId,
              channel: type,
              errorMessage:
                error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      // Scenario flow asked Airi to hand off to a human. Upgrade the "👀"
      // ack on the inbound message to "🙏" so the customer sees a clear
      // "a human will take over" cue even before a manager opens the chat.
      fireTelegramReaction("🙏");

      // Retries a concurrent lifecycle write: the handoff message is already sent.
      await updateConversationHandoffState(
        { _id: conversationId },
        {
          status: "in_progress",
          airi_bot_enabled: false,
          airi_handoff_active: true,
          airi_handoff_started_at: handoffAt,
          airi_handoff_restore_bot_enabled: conversationBotEnabled,
          airi_handoff_source: handoffSource,
          airi_handoff_reason: handoffReason,
          airi_last_suppressed_at: handoffAt,
          airi_last_suppressed_reason: "scenario_handoff",
          airi_last_suppressed_manager_user_id: null,
          airi_last_suppressed_message_id: currentMessageId,
        },
      );
      await realtime.trigger(
        getRealtimeChannelNameForConversation(type, conversationId),
        "airi.handoff",
        {
          conversationId,
          scenarioId: scenarioRuntime.scenarioId,
          scenarioName: scenarioRuntime.scenarioName,
          actionNodeId: scenarioRuntime.selectedActionNodeId || null,
          reason: handoffReason,
          handoffAt: handoffAt.toISOString(),
          botPaused: true,
          handoffSource,
          handoffReason,
        },
      );

      if (
        scenarioRuntime.actionHandoffNotifyEmail?.trim() ||
        scenarioRuntime.actionHandoffNotifyWhatsapp?.trim()
      ) {
        sendHandoffNotifications({
          workspaceId,
          conversationId,
          channel: type,
          conversation,
          chatDocument,
          scenarioRuntime,
          handoffReason,
        });
      }

      logOrchestrationInfo("scenario_assign_human_executed", {
        workspaceId,
        conversationId,
        scenarioId: scenarioRuntime.scenarioId,
        actionNodeId: scenarioRuntime.selectedActionNodeId || null,
        handoffSource,
      });
      await completeScenarioOrWarn("complete_scenario_after_handoff_failed", {
        scenarioRuntime,
        baseState: scenarioStateForResolution,
        completionTimestamp: handoffAt,
        lastMessageId: lastDispatchMessageId,
      });

      return await finishTurn({ status: "ok", scenario_handoff: true });
    }

    if (scenarioRuntime?.actionType === "reply") {
      const replyDecision =
        resolveScenarioReplyExecutionDecision(scenarioRuntime);

      if (replyDecision.kind === "direct_fixed") {
        if (
          !(await checkPoint("Pre-Scenario-Fixed-Reply", {
            preserveScenarioDelivery: true,
          }))
        ) {
          return NextResponse.json({ status: "ok", cancelled: true });
        }

        const scenarioAppointmentAvailability =
          await resolveScenarioWhatsAppAppointmentAvailability({
            runtime: scenarioRuntime,
            workspaceId,
          });
        const calendarAvailability = scenarioAppointmentAvailability
          ? toScenarioCalendarTemplateAvailability(
              scenarioAppointmentAvailability.context,
            )
          : await resolveCalendarAvailabilityForScenarioTemplate({
              workspaceId,
              replyText: replyDecision.replyText,
              runtime: scenarioRuntime,
            });
        const renderedContent = applyScenarioReplyTemplate({
          template: undefined,
          reply: replyDecision.replyText,
          channel: type,
          conversation,
          chatDocument,
          whatsAppInfo: params.whatsAppInfo,
          triggerMessage: newMessage,
          configuredLinks: scenarioRuntime.actionLinkUrls,
          configuredImages: scenarioRuntime.actionImageUrls,
          calendarAvailability,
          ...readScenarioTemplateMemory(scenarioRuntime),
        });
        // Author-defined fixed copy must reach the customer verbatim — no
        // "Airi:" agent prefix and no customer-language translation.
        const fullContent = renderedContent.trim();
        const hasServiceMessage = Boolean(
          scenarioRuntime.actionWhatsAppServiceMessage,
        );
        if (!fullContent && !hasServiceMessage) {
          logOrchestrationInfo("scenario_fixed_reply_empty_skipped", {
            workspaceId,
            conversationId: String(conversation._id),
            scenarioId: scenarioRuntime.scenarioId,
            actionNodeId: scenarioRuntime.selectedActionNodeId || null,
          });
          return await finishTurn({
            status: "ok",
            scenario_reply_empty: true,
          });
        }
        const scenarioWhatsAppCta = resolveScenarioWhatsAppCta({
          channel: type,
          scenarioRuntime,
          targetLanguage: customerReplyLanguage,
        });
        const fixedReplyDeliveryGate = evaluateDelivery(undefined, {
          scenarioDelivery: true,
        });
        if (!fixedReplyDeliveryGate.allowSend) {
          logOrchestrationInfo("scenario_fixed_reply_suppressed", {
            workspaceId,
            conversationId: String(conversation._id),
            messageId: currentMessageId,
            reason: fixedReplyDeliveryGate.reason,
            rolloutBucket: fixedReplyDeliveryGate.rolloutBucket,
            rolloutPercentage: fixedReplyDeliveryGate.rolloutPercentage,
          });
          return await finishTurn({
            status: "ok",
            scenario_reply_suppressed: true,
            deliveryReason: fixedReplyDeliveryGate.reason,
          });
        }

        const outbound = await sendAndPersistOutbound({
          ...params,
          content: fullContent,
          whatsappCtaLink: scenarioWhatsAppCta.whatsappCtaLink,
          whatsappFlowCta: scenarioWhatsAppCta.whatsappFlowCta,
          scenarioOrigin: buildScenarioOutboundOrigin(scenarioRuntime),
          ...resolveScenarioWhatsAppDeliveryProjection({
            runtime: scenarioRuntime,
            appointmentChoices: scenarioAppointmentAvailability?.choices,
          }),
          scenarioAttachments: scenarioRuntime.actionAttachments,
          scenarioImageUrls: scenarioRuntime.actionImageUrls,
          telegramQuickReplies: scenarioRuntime.actionTelegramQuickReplies,
          instagramMessage: scenarioRuntime.actionInstagramConfig,
          telegramLinkUrls: scenarioRuntime.actionLinkUrls,
          telegramLinkButtonLabel:
            scenarioRuntime.actionReplyCtaType === "link" &&
            scenarioRuntime.actionReplyCtaLabel?.trim()
              ? scenarioRuntime.actionReplyCtaLabel.trim()
              : undefined,
        });
        fireTelegramReaction("⚡");
        await clearSuppressedStateAfterDelivery(String(conversation._id)).catch(
          (error) => {
            logOrchestrationWarn(
              "clear_suppression_state_after_fixed_reply_failed",
              {
                conversationId: String(conversation._id),
                errorMessage:
                  error instanceof Error ? error.message : String(error),
              },
            );
          },
        );

        logOrchestrationInfo("scenario_fixed_reply_sent", {
          workspaceId,
          conversationId: String(conversation._id),
          scenarioId: scenarioRuntime.scenarioId,
          actionNodeId: scenarioRuntime.selectedActionNodeId || null,
        });
        await completeScenarioOrWarn(
          "complete_scenario_after_fixed_reply_failed",
          {
            scenarioRuntime,
            baseState: scenarioStateForResolution,
            completionTimestamp: outbound.date || new Date(),
            lastMessageId: String(outbound._id),
          },
        );

        return await finishTurn({ status: "ok", scenario_reply: true });
      }
    }

    if (preResolvedScenarioResolution && !scenarioRuntime) {
      logOrchestrationInfo("skipped_authoritative_scenario_continuation", {
        workspaceId,
        conversationId: String(conversation._id),
        messageId: currentMessageId,
        triggerEventKind: params.triggerEventKind || null,
      });
      return await finishTurn({
        status: "ok",
        skipped_authoritative_scenario_continuation: true,
      });
    }

    if (isProactiveTrigger && !scenarioRuntime) {
      logOrchestrationInfo("skipped_proactive_no_scenario_runtime", {
        workspaceId,
        conversationId: String(conversation._id),
        scenarioOverrideId: params.scenarioOverrideId || null,
      });
      return await finishTurn({
        status: "ok",
        skipped_proactive_no_scenario: true,
      });
    }

    if (
      isScenarioQuickReplyEventKind(params.triggerEventKind) &&
      !scenarioRuntime
    ) {
      logOrchestrationInfo("skipped_quick_reply_no_branch_match", {
        workspaceId,
        conversationId: String(conversation._id),
        quickReplyPayload: params.quickReplyPayload || null,
      });
      return await finishTurn({
        status: "ok",
        skipped_quick_reply_no_branch_match: true,
      });
    }

    if (
      params.triggerEventKind ===
        SCENARIO_TRIGGER_EVENT_KIND.whatsAppFlowReply &&
      !scenarioRuntime
    ) {
      logOrchestrationInfo("skipped_whatsapp_flow_reply_no_branch_match", {
        workspaceId,
        conversationId: String(conversation._id),
        hasWhatsAppFlowResponseJson:
          typeof params.whatsAppFlowResponseJson === "string" &&
          params.whatsAppFlowResponseJson.trim().length > 0,
      });
      await persistUnroutedScenarioForm();
      return await finishTurn({
        status: "ok",
        skipped_flow_reply_no_branch_match: true,
      });
    }

    if (
      !scenarioRuntime &&
      !autoReplySuppressedByRuntimeLock &&
      executionGates.canResolveScenarios &&
      executionGates.canDeliverAutoReply &&
      shouldRunGeneralAutoReply
    ) {
      const deferredGuardDecision = await evaluateCurrentManagerReplyGuard();
      if (deferredGuardDecision.skip) {
        autoReplySuppressedByRuntimeLock =
          await persistManagerReplyGuardSuppression(deferredGuardDecision);
        fireTelegramReaction("🙏");
        logOrchestrationInfo("skipped_manager_reply_guard", {
          workspaceId,
          conversationId: String(conversation._id),
          messageId: currentMessageId,
          reason: deferredGuardDecision.reason,
          managerUserId: deferredGuardDecision.managerUserId,
          evaluatedAfterScenarioMiss: true,
        });
      }
    }

    if (!scenarioRuntime && autoReplySuppressedByRuntimeLock) {
      logOrchestrationInfo("skipped_auto_reply_runtime_lock_after_scenario", {
        workspaceId,
        conversationId: String(conversation._id),
        messageId: currentMessageId,
        reason: autoReplySuppressedByRuntimeLock.reason,
        scenariosEnabled: executionGates.canResolveScenarios,
        triggerEventKind: params.triggerEventKind || null,
      });
      return await finishTurn(autoReplySuppressedByRuntimeLock.responseBody);
    }

    if (!scenarioRuntime && !executionGates.canDeliverAutoReply) {
      logOrchestrationInfo("skipped_auto_reply_disabled_after_scenario", {
        workspaceId,
        conversationId: String(conversation._id),
        messageId: currentMessageId,
        scenariosEnabled: executionGates.canResolveScenarios,
        triggerEventKind: params.triggerEventKind || null,
      });
      return await finishTurn({
        status: "ok",
        skipped_delivery_reason: "auto_reply_disabled",
      });
    }

    if (!scenarioRuntime && !shouldRunGeneralAutoReply) {
      logOrchestrationInfo("skipped_should_reply_false", {
        workspaceId,
        mention,
        mode: process.env.AIRI_AUTO_REPLY_MODE || "always",
        scenarioResolved: false,
      });
      return await finishTurn({ status: "ok", skipped: true });
    }

    if (!scenarioRuntime) {
      const airiCapacity = await ensureCompanyAiriAutoReplyCapacity(
        supabaseAdmin,
        workspaceId,
      );
      if (!airiCapacity.allowed) {
        logOrchestrationInfo("airi_auto_reply_limit_exceeded", {
          workspaceId,
          conversationId: String(conversation._id),
          messageId: currentMessageId,
          reason: COMPANY_AIRI_AUTO_REPLY_LIMIT_EXCEEDED_CODE,
        });
        return await finishTurn({
          status: "ok",
          skipped_airi_limit: true,
          reason: COMPANY_AIRI_AUTO_REPLY_LIMIT_EXCEEDED_CODE,
        });
      }
      params.runtimeCapacityVerifiedAt = new Date().toISOString();
    }
    // Scenario-routed turns deferred language detection for fast dispatch;
    // the AI reply below must still answer in the customer's language.
    await ensurePreRuntimeContext();

    if (!effectiveInputText && inboundHasMedia && !scenarioRuntime) {
      logOrchestrationInfo("skipped_media_only_no_scenario_match", {
        workspaceId,
        conversationId: String(conversation._id),
        messageId: currentMessageId,
        mediaType: normalizedMediaType || null,
        hasInboundMediaUrl: Boolean(inboundMediaUrl),
      });
      const mediaOnlyDeliveryGate = evaluateDelivery();
      if (!mediaOnlyDeliveryGate.allowSend) {
        return await finishTurn({
          status: "ok",
          skipped_media_only_delivery_reason: mediaOnlyDeliveryGate.reason,
        });
      }
      if (!(await checkPoint("Pre-Media-Only-Reply"))) {
        return NextResponse.json({ status: "ok", cancelled: true });
      }
      const mediaOnlyReply = buildMediaOnlyClarification(
        customerReplyLanguage,
        normalizedMediaType || inboundMediaMimeType || null,
      );
      await sendAndPersistOutbound({
        ...params,
        content: `Airi: ${mediaOnlyReply}`,
      });
      fireTelegramReaction("⚡");
      await clearSuppressedStateAfterDelivery(String(conversation._id)).catch(
        (error) => {
          logOrchestrationWarn(
            "clear_suppression_state_after_media_only_failed",
            {
              conversationId: String(conversation._id),
              errorMessage:
                error instanceof Error ? error.message : String(error),
            },
          );
        },
      );
      return await finishTurn({
        status: "ok",
        media_only_clarification: true,
      });
    }

    // 5. FAST PATH: Intent Classification
    if (
      !(await checkPoint("Pre-Intent", {
        preserveScenarioDelivery: Boolean(scenarioRuntime),
      }))
    )
      return NextResponse.json({ status: "ok", cancelled: true });

    const intentFastPath = await runIntentFastPath({
      autoReplyParams: params,
      diagnostics,
      workspaceId,
      conversation,
      effectiveInputText,
      customerReplyLanguage,
      scenarioRuntime,
      workspaceBotSettings,
      conversationPreferredLanguage: conv?.preferred_language,
      workspaceLanguage: companyContext.airiLanguage,
      evaluateDelivery,
      checkPoint,
      stopTyping: () => typing.stop(),
    });
    const threadReplyContext = intentFastPath.threadReplyContext;
    customerReplyLanguage = intentFastPath.customerReplyLanguage;
    if (intentFastPath.handledResponse) {
      return intentFastPath.handledResponse;
    }

    // 6. SLOW PATH: RAG retrieval
    if (
      !(await checkPoint("Pre-RAG", {
        preserveScenarioDelivery: Boolean(scenarioRuntime),
      }))
    )
      return NextResponse.json({ status: "ok", cancelled: true });

    // Wire up Telegram `sendMessageDraft` streaming for private 1:1 chats.
    // Groups/supergroups, business-connection messages, and non-numeric chat
    // ids are not supported by the Telegram API for this method. The binding
    // itself is hoisted above the try/catch; only initialization happens here.
    if (type === "telegram") {
      const chatTypeLower = (params.chatType || "").toLowerCase();
      const isPrivateChat =
        chatTypeLower === "" ||
        chatTypeLower === "private" ||
        chatTypeLower === "user";
      const businessConnectionId =
        (typeof conversation.business_connection_id === "string"
          ? conversation.business_connection_id.trim()
          : "") ||
        (typeof chatDocument?.businessConnectionId === "string"
          ? chatDocument.businessConnectionId.trim()
          : "");
      const rawChatId = params.chatId;
      const numericChatId =
        typeof rawChatId === "number"
          ? rawChatId
          : typeof rawChatId === "string"
            ? Number(rawChatId)
            : Number.NaN;
      if (
        isPrivateChat &&
        !businessConnectionId &&
        Number.isFinite(numericChatId) &&
        numericChatId !== 0
      ) {
        try {
          telegramDraftReveal = new TelegramDraftReveal({
            chatId: numericChatId,
            botToken: params.botToken,
            onFirstDraft: () => {
              // Draft is visible; stop the now-redundant typing action.
              typing.stop();
            },
            // Byte-match contract: the draft body must render to the
            // exact same string (and parse_mode) as `handleTelegramSend`
            // in apps/web/src/lib/airi/reply/delivery/outbound-message.ts.
            // The upstream pipeline is:
            //   textToSend = String("Airi: " + reply).trim()
            //   body       = formatReplyMarkdownForTelegramHtml(textToSend)
            //   parse_mode = "HTML"
            // `revealTelegramDraftFinal` passes the raw reply (no
            // prefix); this closure adds the prefix so both paths
            // produce identical bytes. Otherwise the Telegram client
            // shows the draft bubble alongside the real reply until the
            // draft times out (~4s).
            renderText: (text) => ({
              text: formatReplyMarkdownForTelegramHtml(
                String(`Airi: ${text}`).trim(),
              ),
              parseMode: "HTML",
            }),
          });
        } catch (error) {
          airiOrchestrationLogger.warn("airi.orchestration.telegram_draft", {
            conversationId,
            channel: type,
            note: "streamer_init_failed",
            errorMessage:
              error instanceof Error ? error.message : String(error),
          });
          telegramDraftReveal = null;
        }
      }
    }
    // Web widget token streaming (flagged): mirror incremental reply text to the
    // conversation realtime channel so onboarding / widget UIs can render tokens as
    // they arrive. Throttled to stay within realtime rate limits; the final
    // `message.new` event reconciles the displayed text. Off by default.
    const webWidgetStreamingEnabled =
      type === "web_widget" && process.env.AIRI_WEB_WIDGET_STREAMING === "true";
    let lastReplyDeltaEmitAt = 0;
    const emitWebWidgetReplyDelta = (accumulated: string) => {
      const now = Date.now();
      if (now - lastReplyDeltaEmitAt < 150) return;
      lastReplyDeltaEmitAt = now;
      void realtime
        .trigger(`conversation-${conversation._id}`, "reply.delta", {
          conversationId: String(conversation._id),
          text: accumulated,
        })
        .catch(() => {});
    };

    // Only the widget renders partial text; Telegram reveals the settled reply.
    const onReplyDelta = webWidgetStreamingEnabled
      ? (event: { delta: string; accumulated: string }) =>
          emitWebWidgetReplyDelta(event.accumulated)
      : undefined;

    /**
     * Tear down the draft streamer without dispatching any partial /
     * pre-repair text. Used on error / handoff / superseded / skipped
     * branches where we are NOT sending a reply — leaking a draft there
     * would paint a stale bubble the customer could read.
     *
     * The Bot API does NOT provide a way to explicitly remove a live
     * draft (empty-text `sendMessageDraft` returns HTTP 400 "Text must be
     * non-empty"). On non-reply branches the chat action / draft state
     * fades on its own ~4s after the last update; there is no server-
     * side remedy.
     *
     * Safe to call multiple times.
     */
    const teardownTelegramDraftIfAny = async (): Promise<void> => {
      telegramDraftReveal?.dispose();
    };

    /**
     * Reveal the FINAL post-repair reply as a single draft update, then
     * hand control to `sendAndPersistOutbound`. Must be called with the
     * exact text (including the "Airi: " prefix) that the real send will
     * deliver — the streamer's `renderText` passes it through the same
     * HTML formatter, so the draft bytes and `sendMessage` bytes match
     * and Telegram's client swaps the draft for the real message with
     * no duplicate / ghost bubble.
     *
     * Intentionally fire-and-forget at the orchestration level: if the
     * draft dispatch fails (e.g. rate-limited, 4xx), the real send still
     * goes out and the customer just misses the brief pre-send preview.
     */
    const revealTelegramDraftFinal = async (
      fullText: string,
    ): Promise<void> => {
      await telegramDraftReveal?.commit(fullText);
    };

    const shouldLoadCalendarAvailability =
      threadReplyContext.turnUnderstanding?.calendarAvailabilityRelevant ===
      true;
    // RAG may replace the scenario runtime. Reuse this snapshot only while the
    // persisted scenario/action identity remains the same; re-resolve below
    // when either identity changes.
    const scenarioAppointmentAvailabilityKey = [
      scenarioRuntime?.scenarioId || "",
      scenarioRuntime?.selectedActionNodeId || "",
    ].join(":");
    let scenarioAppointmentAvailability =
      await resolveScenarioWhatsAppAppointmentAvailability({
        runtime: scenarioRuntime,
        workspaceId,
      });
    const generalCalendarAvailabilityContext =
      !scenarioAppointmentAvailability && shouldLoadCalendarAvailability
        ? await withTimeoutFallback({
            label: "buildGoogleCalendarAvailabilityContext",
            promise: buildGoogleCalendarAvailabilityContext({
              workspaceId,
            }).catch(() => null),
            timeoutMs: PRE_RUNTIME_CONTEXT_TIMEOUT_MS,
            fallback: null,
          })
        : null;
    const calendarAvailabilityContext =
      scenarioAppointmentAvailability?.context ||
      generalCalendarAvailabilityContext;

    const ragFlow = await runRagReplyFlow({
      workspaceId,
      conversation,
      currentMessageId,
      channel: type,
      runtimeChannel,
      scenarioRuntime,
      scenarioStateForResolution,
      effectiveInputText,
      customerReplyLanguage,
      threadReplyContext,
      workspaceBotSettings: {
        retrievalQueryMode: workspaceBotSettings.retrievalQueryMode,
        includeRecentConversationInRetrievalContext:
          workspaceBotSettings.includeRecentConversationInRetrievalContext,
        sendKbArticleLinksToUserChannels:
          workspaceBotSettings.sendKbArticleLinksToUserChannels,
        agentPersona: workspaceBotSettings.agentPersona,
        elevenlabsAgentId: workspaceBotSettings.elevenlabsAgentId,
        customInstructions: workspaceBotSettings.customInstructions,
        greetingBehavior: workspaceBotSettings.greetingBehavior,
        escalationBehavior: workspaceBotSettings.escalationBehavior,
        responseStyle: workspaceBotSettings.responseStyle,
        customAvailableActions: workspaceBotSettings.customAvailableActions,
        channelInstructions: workspaceBotSettings.channelInstructions,
      },
      companyContext: {
        businessContext: companyContext.businessContext,
        dynamicTags: companyContext.dynamicTags ?? [],
      },
      calendarAvailabilityBlock:
        calendarAvailabilityContext?.promptBlock || undefined,
      calendarAvailabilitySignature:
        calendarAvailabilityContext?.signature || undefined,
      widgetRagContext,
      followUpInstruction,
      systemPromptOverride,
      fastMode,
      alreadyGreeted: intentFastPath.alreadyGreetedToday,
      autoReplyParams: {
        scenarioOverrideId: params.scenarioOverrideId,
        triggerEventKind: params.triggerEventKind,
        quickReplyPayload: params.quickReplyPayload,
        whatsAppFlowResponseJson: params.whatsAppFlowResponseJson,
        newMessage: params.newMessage,
      },
      checkPoint,
      onReplyDelta,
    });
    logTiming("rag_flow_completed", {
      handledResponse: Boolean(ragFlow.handledResponse),
      resultType: ragFlow.ragResult?.type || null,
      scenarioResolved: Boolean(ragFlow.scenarioRuntime),
    });
    if (ragFlow.handledResponse) {
      await teardownTelegramDraftIfAny();
      return ragFlow.handledResponse;
    }
    scenarioRuntime = ragFlow.scenarioRuntime;
    const finalScenarioAppointmentAvailabilityKey = [
      scenarioRuntime?.scenarioId || "",
      scenarioRuntime?.selectedActionNodeId || "",
    ].join(":");
    if (
      finalScenarioAppointmentAvailabilityKey !==
      scenarioAppointmentAvailabilityKey
    ) {
      scenarioAppointmentAvailability =
        await resolveScenarioWhatsAppAppointmentAvailability({
          runtime: scenarioRuntime,
          workspaceId,
        });
    }
    const ragResult = ragFlow.ragResult!;
    const queryText = ragFlow.queryText!;
    const persistReplyTrace = async (options: {
      delivered: boolean;
      deliveredReason?: string | null;
      outboundMessageId?: string | null;
    }) => {
      const traceSummary =
        (ragResult.retrievalSummary as Record<string, unknown> | undefined) ||
        {};
      const chosenSourceIds = Array.isArray(traceSummary.chosenSourceIds)
        ? traceSummary.chosenSourceIds
            .map((item) => String(item || "").trim())
            .filter(Boolean)
        : [
            ...(ragResult.snippet?.id ? [String(ragResult.snippet.id)] : []),
            ...(ragResult.kbArticles || []).map((article) =>
              String(article.id),
            ),
          ];

      const trace = {
        workspaceId,
        conversationId: String(conversation._id),
        inboundMessageId: currentMessageId,
        outboundMessageId: options.outboundMessageId || null,
        channel: type,
        delivered: options.delivered,
        deliveredReason: options.deliveredReason || null,
        queryText,
        lastMessageQuery: threadReplyContext.lastMessageQuery,
        intentAnchor: threadReplyContext.intentAnchor,
        activeGoals: threadReplyContext.activeGoals,
        openAsks: threadReplyContext.openAsks,
        queryVariants: threadReplyContext.queryVariants,
        followUpMode: threadReplyContext.followUpMode,
        followUpAnchor: threadReplyContext.followUpAnchor,
        fallbackPlanningUsed:
          threadReplyContext.turnUnderstanding?.planningSource === "fallback",
        retrievalPriority: ragResult.decision?.priority || null,
        groundingSourceKind: resolveReplyTraceGroundingSourceKind({
          hasSnippet: Boolean(ragResult.snippet),
          hasKB: Boolean(ragResult.kbArticles?.length),
        }),
        chosenSourceIds,
        snippetShortCircuitedKB: Boolean(traceSummary.snippetShortCircuitedKB),
        model: ragResult.generationInference?.model || null,
        provider: ragResult.generationInference?.provider || null,
        latencyMs: ragResult.generationInference?.latencyMs || null,
        finishReason:
          ragResult.generationInference?.finishReason ||
          ragResult.generationFinishReason ||
          null,
        fallbackAction: ragResult.fallbackAction || null,
        fallbackReason: ragResult.fallbackReason || null,
        coverage: ragResult.coverage || null,
        activeSelection: threadReplyContext.activeSelection
          ? {
              label: threadReplyContext.activeSelection.label,
              sourceIds: threadReplyContext.activeSelection.sourceIds,
              quotedPriceText:
                threadReplyContext.activeSelection.quotedPriceText,
            }
          : null,
        selectionPinned: Boolean(ragResult.retrievalSummary?.selectionPinned),
        historyCompacted: Boolean(threadReplyContext.historyCompacted),
        summaryCoveredThroughMessageId:
          threadReplyContext.summaryCoveredThroughMessageId || null,
        summaryCoveredMessageCount:
          threadReplyContext.summaryCoveredMessageCount || null,
        ragWideEvent:
          (ragResult.retrievalSummary?.wideEvent as
            | Record<string, unknown>
            | undefined) || null,
      };
      const persistTrace = options.delivered
        ? persistAiriReplyTraceAfterDelivery
        : persistAiriReplyTrace;
      await persistTrace(trace).catch((error) => {
        airiReplyLogger.warn("airi.reply.trace", {
          workspaceId,
          conversationId: String(conversation._id),
          messageId: currentMessageId,
          note: "persist_failed",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });
    };

    const responseConfidence = estimateRagResponseConfidence(ragResult);
    const finalDeliveryGate = evaluateDelivery(responseConfidence, {
      scenarioDelivery: Boolean(scenarioRuntime),
    });

    const trackReplyKnowledgeGap = async (afterDelivery: boolean) => {
      const trackGap = afterDelivery
        ? trackMissingKnowledgeGapAfterDelivery
        : trackMissingKnowledgeGap;
      try {
        if (ragResult.missingKnowledgeSignal?.intent) {
          await trackGap({
            workspaceId,
            intent: ragResult.missingKnowledgeSignal.intent,
            topic: ragResult.missingKnowledgeSignal.topic,
            conversationId: String(conversation._id),
            messageId: currentMessageId,
            channel: type,
            query: queryText,
            reason: ragResult.missingKnowledgeSignal.reason,
            source: "runtime",
            responseConfidence,
            retrievalPriority: ragResult.decision?.priority,
          });
          return;
        }

        if (ragResult.type === "fallback") {
          await trackGap({
            workspaceId,
            intent: "unknown",
            conversationId: String(conversation._id),
            messageId: currentMessageId,
            channel: type,
            query: queryText,
            reason: "generic_fallback_no_grounded_context",
            source: "runtime",
            responseConfidence,
            retrievalPriority: ragResult.decision?.priority,
          });
        }
      } catch (error) {
        airiReplyLogger.warn("airi.reply.knowledge_gap", {
          workspaceId,
          conversationId: String(conversation._id),
          messageId: currentMessageId,
          note: afterDelivery
            ? "post_delivery_gap_track_failed"
            : "gap_track_failed",
          intent: ragResult.missingKnowledgeSignal?.intent || "unknown",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    };

    // 7. Feedback (Thinking reasoning)
    if (type === "web_widget" && ragResult?.decision?.reasoning) {
      await realtime.trigger(
        `conversation-${conversation._id}`,
        "airi.thinking",
        {
          workspaceId,
          reasoning: ragResult.decision.reasoning,
          phase: ragResult.type,
        },
      );
    }

    // 8. Handle Result & Persistence
    const content = (ragResult.content || "").trim();
    if (content) {
      if (!finalDeliveryGate.allowSend) {
        if (finalDeliveryGate.reason === "confidence_below_threshold") {
          await trackMissingKnowledgeGap({
            workspaceId,
            intent: ragResult.missingKnowledgeSignal?.intent || "unknown",
            topic: ragResult.missingKnowledgeSignal?.topic || null,
            conversationId: String(conversation._id),
            messageId: currentMessageId,
            channel: type,
            query: queryText,
            reason: "low_confidence_threshold",
            source: "runtime",
            responseConfidence,
            retrievalPriority: ragResult.decision?.priority,
            metadata: {
              minConfidence: 0,
              resultType: ragResult.type,
            },
          }).catch((error) => {
            airiReplyLogger.warn("airi.reply.knowledge_gap", {
              workspaceId,
              conversationId: String(conversation._id),
              messageId: currentMessageId,
              note: "low_confidence_gap_track_failed",
              intent: ragResult.missingKnowledgeSignal?.intent || "unknown",
              topic: ragResult.missingKnowledgeSignal?.topic || null,
              resultType: ragResult.type,
              errorMessage:
                error instanceof Error ? error.message : String(error),
            });
          });
        }

        airiReplyLogger.info("airi.reply.turn_outcome", {
          workspaceId,
          conversationId: String(conversation._id),
          messageId: currentMessageId,
          channel: type,
          outcome: "suppressed",
          resultType: ragResult.type,
          fallbackAction: ragResult.fallbackAction || "use_generated_reply",
          fallbackReason: ragResult.fallbackReason || null,
          reason: finalDeliveryGate.reason,
          rolloutBucket: finalDeliveryGate.rolloutBucket,
          rolloutPercentage: finalDeliveryGate.rolloutPercentage,
          minConfidence: finalDeliveryGate.minConfidence,
          responseConfidence: finalDeliveryGate.responseConfidence,
          retrievalPriority: ragResult.decision?.priority || null,
        });
        await persistReplyTrace({
          delivered: false,
          deliveredReason: finalDeliveryGate.reason || "delivery_gate",
        });
        typing.stop();
        await teardownTelegramDraftIfAny();
        return NextResponse.json({
          status: "ok",
          skipped_delivery_reason: finalDeliveryGate.reason,
          responseConfidence,
          reply_outcome: "suppressed",
        });
      }

      if (
        !(await checkPoint("Pre-Final-Send", {
          preserveScenarioDelivery: Boolean(scenarioRuntime),
        }))
      ) {
        await teardownTelegramDraftIfAny();
        return NextResponse.json({ status: "ok", cancelled: true });
      }

      if (!scenarioRuntime) {
        const preSendBurst = await resolveInboundBurstOwnership({
          conversationId: String(conversation._id),
          currentMessageId,
        });
        if (!preSendBurst.shouldProcess) {
          airiReplyLogger.info("airi.reply.turn_outcome", {
            workspaceId,
            conversationId: String(conversation._id),
            messageId: currentMessageId,
            channel: type,
            outcome: "superseded",
            resultType: ragResult.type,
            reason: preSendBurst.reason,
            burstOwnerMessageId: preSendBurst.burstOwnerMessageId || null,
            answeredByMessageId: preSendBurst.answeredByMessageId || null,
          });
          await persistReplyTrace({
            delivered: false,
            deliveredReason: preSendBurst.reason,
          });
          typing.stop();
          await teardownTelegramDraftIfAny();
          return NextResponse.json({
            status: "ok",
            skipped_burst: true,
            reason: preSendBurst.reason,
          });
        }
      }

      const allowKbArticleLinks = shouldAttachKbArticleLinks({
        channel: type,
        workspaceBotSettings,
      });
      const articleLinks = allowKbArticleLinks
        ? ragResult.attachedArticleLinks
        : undefined;
      const calendarAvailabilityForTemplate =
        scenarioAppointmentAvailability !== undefined
          ? toScenarioCalendarTemplateAvailability(
              scenarioAppointmentAvailability.context,
            )
          : generalCalendarAvailabilityContext !== null &&
              generalCalendarAvailabilityContext !== undefined
            ? toScenarioCalendarTemplateAvailability(
                generalCalendarAvailabilityContext,
              )
            : await resolveCalendarAvailabilityForScenarioTemplate({
                workspaceId,
                replyText: content,
                runtime: scenarioRuntime,
              });
      const renderedContent = applyScenarioReplyTemplate({
        template: undefined,
        reply: content,
        channel: type,
        conversation,
        chatDocument,
        whatsAppInfo: params.whatsAppInfo,
        triggerMessage: newMessage,
        configuredLinks: scenarioRuntime?.actionLinkUrls,
        configuredImages: scenarioRuntime?.actionImageUrls,
        attachedArticleLinks: articleLinks,
        calendarAvailability: calendarAvailabilityForTemplate,
        ...readScenarioTemplateMemory(scenarioRuntime),
        // Generated text may echo a token; only authored text fails closed.
        requirePromptInputs: false,
      });
      const ensuredFinalReply = await ensureReplyLanguage({
        text: renderedContent,
        targetLanguage: customerReplyLanguage,
        workspaceId,
        elevenlabsAgentId: workspaceBotSettings.elevenlabsAgentId,
      });
      if (ensuredFinalReply.translationFallbackUsed) {
        airiReplyLogger.warn("airi.reply.delivery", {
          workspaceId,
          conversationId: String(conversation._id),
          scenarioId: scenarioRuntime?.scenarioId || null,
          note: "final_translation_fallback_used",
          targetLanguage: customerReplyLanguage,
          detectedSourceLanguage: ensuredFinalReply.detectedSourceLanguage,
        });
      }
      const finalReplyText = appendKbArticleLinksToReply({
        reply: ensuredFinalReply.text,
        articleLinks,
        language: customerReplyLanguage,
      });
      const guardedReply = finalizeAssistantReplyForDelivery({
        reply: finalReplyText,
      });
      if (!guardedReply.reply) {
        airiReplyLogger.warn("airi.reply.delivery", {
          workspaceId,
          conversationId: String(conversation._id),
          messageId: currentMessageId,
          note: "final_reply_empty_after_normalization",
          resultType: ragResult.type,
          fallbackAction: ragResult.fallbackAction || "use_generated_reply",
          fallbackReason: ragResult.fallbackReason || null,
        });
        await persistReplyTrace({
          delivered: false,
          deliveredReason: "empty_after_normalization",
        });
        typing.stop();
        await teardownTelegramDraftIfAny();
        return NextResponse.json({
          status: "ok",
          skipped_empty_reply: true,
          reply_outcome: "skipped_empty_reply",
        });
      }
      const nativeGroundedReplyOptions =
        Array.isArray(ragResult.groundedReplyOptions) &&
        ragResult.groundedReplyOptions.length > 0 &&
        !scenarioRuntime?.actionWhatsAppServiceMessage &&
        (type === "telegram" || type === "whatsapp")
          ? ragResult.groundedReplyOptions
          : undefined;
      const deliveredReplyText =
        nativeGroundedReplyOptions || type === "telegram" || type === "whatsapp"
          ? guardedReply.reply
          : appendGroundedReplyOptionsInlineText({
              reply: guardedReply.reply,
              options: ragResult.groundedReplyOptions,
            });
      const fullContent = formatFinalizedAssistantReplyForOutbound({
        reply: deliveredReplyText,
        includeAssistantPrefix: !scenarioRuntime?.actionWhatsAppServiceMessage,
      });
      const scenarioWhatsAppCta = resolveScenarioWhatsAppCta({
        channel: type,
        scenarioRuntime,
        targetLanguage: customerReplyLanguage,
      });
      const kbArticleCtaLink =
        allowKbArticleLinks &&
        type === "whatsapp" &&
        articleLinks &&
        articleLinks.length === 1
          ? { url: articleLinks[0].url, title: articleLinks[0].title }
          : undefined;
      const whatsappCtaLink =
        nativeGroundedReplyOptions && nativeGroundedReplyOptions.length > 0
          ? undefined
          : scenarioWhatsAppCta.whatsappCtaLink || kbArticleCtaLink;

      const attachButtons =
        shouldAttachScenarioButtons({
          scenarioRuntime,
          ragResultType: ragResult.type,
        }) &&
        !(nativeGroundedReplyOptions && nativeGroundedReplyOptions.length > 0);
      const whatsappBookCallChoices =
        nativeGroundedReplyOptions && nativeGroundedReplyOptions.length > 0
          ? undefined
          : scenarioAppointmentAvailability?.choices;
      const whatsappVoiceReply = resolveWhatsAppVoiceReplyIntent({
        channel: type,
        enabled: workspaceBotSettings.whatsappVoiceRepliesEnabled === true,
        inboundMediaType: normalizedMediaType,
        text: deliveredReplyText,
        language: customerReplyLanguage,
        grounded: Boolean(
          ragResult.snippet ||
            ragResult.kbArticles?.length ||
            ragResult.rankedEvidence?.length,
        ),
        hasScenario: Boolean(scenarioRuntime),
        hasInteractivePayload: Boolean(
          whatsappCtaLink ||
            scenarioWhatsAppCta.whatsappFlowCta ||
            nativeGroundedReplyOptions?.length ||
            whatsappBookCallChoices?.length,
        ),
        hasAttachments: Boolean(
          scenarioRuntime?.actionAttachments?.length ||
            scenarioRuntime?.actionImageUrls?.length,
        ),
        proactive: Boolean(params.proactiveTrigger || isScenarioTimeoutTurn),
      });
      // Reveal the single deferred draft right before the real send.
      // Pass the raw reply (no "Airi: " prefix) — the streamer's
      // `renderText` adds it so draft bytes match `handleTelegramSend`.
      await revealTelegramDraftFinal(deliveredReplyText);
      logTiming("pre_final_send_ready", {
        resultType: ragResult.type,
        scenarioResolved: Boolean(scenarioRuntime),
        replyLength: guardedReply.reply.length,
      });
      const outbound = await sendAndPersistOutbound({
        ...params,
        content: fullContent,
        ...(whatsappVoiceReply
          ? {
              whatsappVoiceReply,
              temporalDispatchPolicy: "at_most_once" as const,
            }
          : {}),
        whatsappCtaLink,
        whatsappFlowCta:
          nativeGroundedReplyOptions && nativeGroundedReplyOptions.length > 0
            ? undefined
            : scenarioWhatsAppCta.whatsappFlowCta,
        scenarioOrigin: buildScenarioOutboundOrigin(scenarioRuntime),
        ...resolveScenarioWhatsAppDeliveryProjection({
          runtime: scenarioRuntime,
          appointmentChoices: whatsappBookCallChoices,
        }),
        scenarioAttachments: scenarioRuntime?.actionAttachments,
        scenarioImageUrls: scenarioRuntime?.actionImageUrls,
        groundedReplyOptions: nativeGroundedReplyOptions,
        instagramMessage: scenarioRuntime?.actionInstagramConfig,
        telegramQuickReplies: attachButtons
          ? scenarioRuntime?.actionTelegramQuickReplies
          : undefined,
        telegramLinkUrls:
          nativeGroundedReplyOptions && nativeGroundedReplyOptions.length > 0
            ? undefined
            : scenarioRuntime?.actionLinkUrls,
        telegramLinkButtonLabel:
          !nativeGroundedReplyOptions &&
          scenarioRuntime?.actionReplyCtaType === "link" &&
          scenarioRuntime?.actionReplyCtaLabel?.trim()
            ? scenarioRuntime.actionReplyCtaLabel.trim()
            : undefined,
      });
      // Reply delivered — upgrade the "👀" ack to "⚡" so the user can see at
      // a glance which of their messages Airi actually handled.
      fireTelegramReaction("⚡");
      logTiming("final_send_completed", {
        outboundMessageId: String(outbound._id),
        resultType: ragResult.type,
        scenarioResolved: Boolean(scenarioRuntime),
      });
      const postDeliveryTasks: Promise<void>[] = [
        persistReplyTrace({
          delivered: true,
          outboundMessageId: String(outbound._id),
        }),
        trackReplyKnowledgeGap(true),
      ];
      if (ragResult.snippet) {
        postDeliveryTasks.push(
          publishAiriSuggestionAfterDelivery({
            workspaceId,
            conversationId: String(conversation._id),
            messageId: currentMessageId,
            realtimePayload: createSuggestionPayload(
              currentMessageId,
              ragResult.snippet,
            ),
            score: ragResult.snippet.score,
            category: ragResult.snippet.category,
            approved: Boolean(ragResult.shouldAutoSend),
            autoSent: Boolean(ragResult.shouldAutoSend),
          }).catch((error) => {
            airiReplyLogger.warn("airi.reply.suggestion", {
              workspaceId,
              conversationId: String(conversation._id),
              messageId: currentMessageId,
              note: "post_delivery_publish_failed",
              errorMessage:
                error instanceof Error ? error.message : String(error),
            });
          }),
        );
      }
      await Promise.all(postDeliveryTasks);
      airiReplyLogger.info("airi.reply.turn_outcome", {
        workspaceId,
        conversationId: String(conversation._id),
        messageId: currentMessageId,
        outboundMessageId: String(outbound._id),
        channel: type,
        outcome: "delivered",
        resultType: ragResult.type,
        fallbackAction: ragResult.fallbackAction || "use_generated_reply",
        fallbackReason: ragResult.fallbackReason || null,
        retrievalPriority: ragResult.decision?.priority || null,
        responseConfidence,
        replyLength: guardedReply.reply.length,
        wasTrimmed: guardedReply.wasTrimmed,
        attachedArticleLinkCount: articleLinks?.length || 0,
      });
      await clearSuppressedStateAfterDelivery(String(conversation._id)).catch(
        (error) => {
          logOrchestrationWarn(
            "clear_suppression_state_after_final_reply_failed",
            {
              conversationId: String(conversation._id),
              scenarioId: scenarioRuntime?.scenarioId || null,
              messageId: currentMessageId,
              errorMessage:
                error instanceof Error ? error.message : String(error),
            },
          );
        },
      );
      // Like the fixed-reply exit, anchor a pending action-outcome wait to
      // this outbound; the no-reply timer fails closed without the anchor.
      if (scenarioRuntime?.pendingConditionNodeId) {
        await completeScenarioOrWarn(
          "complete_scenario_after_ai_reply_failed",
          {
            scenarioRuntime,
            baseState: scenarioStateForResolution,
            completionTimestamp: outbound.date || new Date(),
            lastMessageId: String(outbound._id),
          },
        );
      }

      // If we auto-sent a snippet, update the suggestion with the actual outbound message ID
      if (ragResult.shouldAutoSend && ragResult.snippet) {
        await updateSuggestionMessageIdAfterDelivery({
          sourceMessageId: currentMessageId,
          outboundMessageId: String(outbound._id),
        });
      }
    }

    if (!content) {
      airiReplyLogger.info("airi.reply.turn_outcome", {
        workspaceId,
        conversationId: String(conversation._id),
        messageId: currentMessageId,
        channel: type,
        outcome: "no_content",
        resultType: ragResult.type,
        fallbackAction: ragResult.fallbackAction || null,
        fallbackReason: ragResult.fallbackReason || null,
        retrievalPriority: ragResult.decision?.priority || null,
      });
      await persistReplyTrace({
        delivered: false,
        deliveredReason: "no_content",
      });
      await trackReplyKnowledgeGap(false);
    }

    typing.stop();
    await teardownTelegramDraftIfAny();
    const hadRagContent = Boolean((ragResult.content || "").trim());
    return NextResponse.json({
      status: "ok",
      reply_outcome: hadRagContent ? "delivered_or_ready" : "no_content",
    });
  } catch (error) {
    logOrchestrationError("critical_failure", error, {
      conversationId: String(conversation._id),
    });
    typing.stop();
    // If we crashed mid-stream, stop accepting new deltas and wait for any
    // in-flight draft update to settle. There is no Bot API to proactively
    // remove the animated draft bubble (empty text is rejected with
    // HTTP 400), so it will fade on the client ~4s after the last update.
    // We deliberately do not emit an error reaction here (see
    // fireTelegramReaction lifecycle notes): the existing "👀" ack stays,
    // signaling "seen but something went wrong silently".
    telegramDraftReveal?.dispose();
    throw error;
  }
};

const scopedAiriAutoReply: typeof airiAutoReplyImpl = (params, dependencies) =>
  dependencies.runTextAiAction(
    {
      workspaceId: params.workspaceId,
      actionId: `auto-reply:${params.conversation._id}:${params.newMessage._id}`,
    },
    () => airiAutoReplyImpl(params, dependencies),
  );

const airiAutoReply = traceableChain(scopedAiriAutoReply, {
  name: "airi.runtime.auto_reply",
  tags: ["airi", "runtime", "auto-reply"],
  getMetadata: (params) => ({
    channel: params.type || null,
    trigger_event_kind:
      params.triggerEventKind || SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
  }),
  getSessionIdentity: (params) => ({
    conversationId: String(params.conversation?._id || ""),
    workspaceId: String(params.workspaceId || ""),
  }),
  processInputs: (inputs) => {
    const payload = (
      "input" in inputs ? inputs.input : inputs
    ) as AiriAutoReplyParams;
    return {
      workspace_id: String(payload.workspaceId || ""),
      conversation_id: String(payload.conversation?._id || ""),
      message_id: String(payload.newMessage?._id || ""),
      channel: payload.type || null,
      inbound_text_preview: previewText(payload.newMessage?.text, 240),
      media_type: payload.newMessage?.mediaType || null,
      quick_reply_payload_preview: previewText(payload.quickReplyPayload, 160),
      scenario_override_id: payload.scenarioOverrideId || null,
      trigger_event_kind:
        payload.triggerEventKind || SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
    };
  },
  processOutputs: (outputs) => {
    const result = (
      "outputs" in outputs ? outputs.outputs : outputs
    ) as Response;
    return {
      response_type: "response",
      status: result.status,
      ok: result.ok,
    };
  },
});

export default airiAutoReply;
