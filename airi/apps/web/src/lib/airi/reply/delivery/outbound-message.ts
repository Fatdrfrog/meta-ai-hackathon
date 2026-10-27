import {
  CUSTOMER_MEDIA_PROVIDER_TTL_SECONDS,
  resolveCustomerMediaReadUrl,
} from "@/lib/media/customer-media-read-url";
import {
  isGreetingMessage,
  markGreetingSentToday,
} from "@/lib/airi/conversation";
import {
  formatReplyMarkdownForInstagram,
  formatReplyMarkdownForTelegramHtml,
  formatReplyMarkdownForWhatsApp,
} from "@/lib/airi/reply/delivery/reply-rich-text-format";
import { reserveTemporalOutboundDispatch } from "@/lib/airi/reply/delivery/temporal-outbound";
import { resolveScenarioDeliveryOwnership } from "@icecore/airi-runtime/delivery-gates";
import { WhatsAppServiceWindowClosedError } from "@/lib/airi/reply/delivery/whatsapp-service-message";
import { sendWhatsAppServiceMessage } from "@/lib/airi/reply/delivery/whatsapp-service-message-send";
import {
  prepareWhatsAppVoiceReply,
  WHATSAPP_VOICE_REPLY_MAX_CHARACTERS,
} from "@/lib/airi/reply/delivery/whatsapp-voice-reply";
import { stripAiriPrefix } from "@/lib/airi/reply/thread/reply-text-utils";
import { stripKbArticleLinksFooter } from "@/lib/airi/reply/runtime/dispatch";
import { airiReplyLogger } from "@/lib/airi/reply/runtime/reply-logging";
import { appendMessageToConversationById } from "@/lib/conversation-messages";
import {
  buildEmailReplyHeaders,
  resolveActiveEmailProvider,
} from "@/lib/email/send-email";
import {
  buildInstagramAttachmentMessagePayload,
  INSTAGRAM_BUTTON_TEMPLATE_TEXT_MAX_CHARS,
  INSTAGRAM_TEXT_MAX_BYTES,
  postInstagramGraph,
  readInstagramSendId,
} from "@/lib/instagram/outbound";
import {
  InstagramSendError,
  readInstagramGraphFailure,
  throwInstagramGraphFailure,
  toInstagramSendError,
} from "@/lib/instagram/send-errors";
import { upsertWhatsAppLlmAnswerReviewItem } from "@/lib/llm-analytics/whatsapp-feedback";
import { enqueueWhatsAppLlmHelpfulnessPromptWithOutbox } from "@/lib/cross-store-outbox";
import { checkMessagingWindowForConversation } from "@/lib/messaging-window";
import { postmarkSendEmail } from "@/lib/postmark";
import { triggerRealtimeEvent } from "@/lib/realtime/server";
import { normalizeScenarioActionAttachments } from "@/lib/scenarios/action-attachments";
import { resolveScenarioActionAttachmentHttpsUrl } from "@/lib/scenarios/scenario-asset-resolve";
import { normalizeInstagramConfig } from "@/lib/scenarios/instagram-reply-config";
import { coerceTelegramQuickRepliesToRows } from "@/lib/scenarios/normalization";
import { normalizeWhatsAppSessionChoices } from "@/lib/scenarios/whatsapp-session-choices";
import { trackScenarioFlowSent } from "@/lib/scenarios/scenario-flow-analytics";
import {
  WHATSAPP_FLOW_INTEGRITY_BLOCK_CODE,
  getActiveScenarioFlowSuppression,
  getWhatsAppFlowErrorMessage,
  isWhatsAppFlowIntegrityBlockError,
  suppressScenarioFlowAfterIntegrityBlock,
  type ActiveScenarioFlowSuppression,
} from "@/lib/scenarios/scenario-flow-suppression";
import { fetchSourceWithCredentialsResult } from "@/lib/sources/utils";
import * as telegramApi from "@/lib/telegram";
import { parseTelegramCompositeChatId } from "@/lib/telegram/chat-id";
import { hasStoredTelegramBotToken } from "@/lib/integrations/source-status";
import { readTelegramBotToken } from "@/lib/telegram/telegram-source";
import type {
  TelegramInlineButton,
  TelegramInlineKeyboard,
} from "@/lib/telegram";
import { resolveBusinessConnectionId } from "@/lib/telegram-business-connection";
import {
  TELEGRAM_CALLBACK_DATA_MAX_UTF8_BYTES,
  TELEGRAM_INLINE_BUTTON_TEXT_MAX_CHARS,
} from "@/lib/telegram/bot-api-inline-keyboard";
import * as whatsappApi from "@/lib/whatsapp";
import { buildFlowEndpointTokenFromConfig } from "@/lib/whatsapp/flows/endpoint-token";
import {
  resolveFreshWhatsAppSendContext,
  resolveWhatsAppSendContext,
} from "@/lib/whatsapp/send-context";
import type { WhatsAppTemplateSendComponentInput } from "@/lib/whatsapp/templates/message-types";
import { buildStoredWhatsAppTemplatePreview } from "@/lib/whatsapp/templates/preview";
import Message, { buildTemporalDeliveryKeyFilter } from "@/models/message";
import User from "@/models/user";
import { Channel, ChatDocument, ConversationDocument } from "@/types/models";
import {
  MAX_SCENARIO_REPLY_IMAGES,
  compileWhatsAppServiceMessage,
  resolveSendableWhatsAppFlowProviderId,
  resolveWhatsAppFlowProviderId,
  resolveWhatsAppFlowSourceBinding,
  type ScenarioActionAttachment,
  type ScenarioInstagramButton,
  type ScenarioInstagramConfig,
  type ScenarioTelegramQuickReplyRow,
  type ScenarioWhatsAppServiceMessage,
  type ScenarioWhatsAppSessionChoice,
  type WhatsAppFlowConfig,
  type WhatsAppServiceMessagePreview,
} from "@icecore/scenario-contracts";
import {
  AiriOutboundPreparationFailedError,
  AiriOutboundProviderRejectedError,
  type AiriConversationPostDeliveryEffect,
} from "@icecore/temporal";
import {
  appendGroundedReplyOptionsInlineText,
  buildGroundedReplyOptionCallbackKey,
} from "@icecore/shared/lib/grounded-reply-options";
import { resolveInstagramGraphBase } from "@icecore/shared/lib/meta/graph-version";
import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";
import {
  buildNormalizedWhatsAppContact,
  getWhatsAppLogIdentity,
  resolveStoredWhatsAppRecipientTarget,
  resolveWhatsAppRecipientTarget,
  type WhatsAppNormalizedContact,
} from "@icecore/shared/lib/whatsapp/contact-identities";
import { truncateUtf8 } from "@icecore/shared/lib/utf8";
import { normalizeWhatsAppMessageId } from "@icecore/shared/lib/whatsapp/message-id";
import type {
  GroundedReplyOption,
  StoredGroundedReplyOptionsPreview,
  StoredMessageMediaType,
  StoredWhatsAppFlowFieldMetadataPreview,
} from "@icecore/shared/types/message-preview";
import {
  getRealtimeChannelNameForConversation,
  isTelegramSource,
} from "@icecore/shared/types/sources";
import { createHash, randomUUID } from "node:crypto";
import { isMongoDuplicateKeyError } from "@icecore/shared/lib/mongo-errors";
import {
  resolveConversationReplySourceId,
  resolveWorkspaceChatSourceId,
} from "@icecore/shared/lib/conversation-reply-source";

type OutboundContext = {
  sourceMessageId?: string;
  newMessage?: { date?: Date | string | null };
  behaviorRunId?: string;
  behaviorRun?: import("@/lib/scenarios/behavior-runs").BehaviorRun;
  type: Channel;
  chatId?: string | number;
  conversation: ConversationDocument;
  workspaceId: string;
  chatDocument: ChatDocument;
  content: string;
  botToken?: string;
  whatsAppInfo?: {
    phoneNumberId?: string;
    accessToken?: string;
    contactData?: WhatsAppNormalizedContact | null;
    [key: string]: unknown;
  };
  instagramInfo?: {
    accessToken: string;
    pageId?: string;
    recipientId?: string;
    commentId?: string;
    threadType?: string;
    authMethod?: string;
    [key: string]: unknown;
  };
  chatType?: string;
  /** For WhatsApp: render a CTA URL button instead of exposing raw URL in text. */
  whatsappCtaLink?: { url: string; title?: string };
  /** For WhatsApp: send an interactive Flow CTA button. */
  whatsappFlowCta?: {
    flowId?: string;
    flowName?: string;
    managedSourceId?: string;
    managedWabaId?: string;
    flowCta?: string;
    flowToken?: string;
    responseFieldMetadata?: StoredWhatsAppFlowFieldMetadataPreview[] | null;
    flowActionType?: "navigate" | "data_exchange";
    flowActionPayload?: Record<string, unknown>;
    headerText?: string;
    footerText?: string;
    evaluationId?: string;
    scenarioId?: string;
    scenarioName?: string;
    actionNodeId?: string;
  };
  /** For WhatsApp: send approved template message instead of plain text. */
  whatsappTemplate?: {
    name: string;
    languageCode?: string;
    components?: WhatsAppTemplateSendComponentInput[];
    /** The scenario compiler selected its header from the template definition. */
    headerMediaSource?: "template";
  };
  /** Scenario provenance for outbound messages that do not carry a Flow CTA. */
  scenarioOrigin?: {
    scenarioId: string;
    scenarioName?: string;
    actionNodeId?: string;
  };
  /** Structured scenario action media. WhatsApp sends at most one in the primary message. */
  scenarioAttachments?: ScenarioActionAttachment[];
  /** Legacy scenario-configured asset URLs. */
  scenarioImageUrls?: string[];
  /**
   * Telegram inline-keyboard branch buttons (row-major: each inner array is one client row).
   * Legacy flat `{ text, payload }[]` is coerced to one button per row.
   */
  telegramQuickReplies?:
    | ScenarioTelegramQuickReplyRow[]
    | Array<{ text: string; payload: string }>;
  /** Instagram Send API payload selected in the scenario Instagram builder. */
  instagramMessage?: ScenarioInstagramConfig;
  /** Canonical scenario-authored WhatsApp service message. */
  whatsappServiceMessage?: ScenarioWhatsAppServiceMessage;
  /** Automatic voice reply intent. Audio is prepared only at the delivery edge. */
  whatsappVoiceReply?: { language?: string | null };
  /** Live appointment options resolved for the canonical message occurrence. */
  whatsappServiceAppointmentChoices?: ScenarioWhatsAppSessionChoice[];
  /**
   * Scenario-configured link URLs.  When the channel is Telegram, the first
   * valid HTTP URL is rendered as an inline-keyboard URL button so it appears
   * as a native "link" button beneath the message.
   */
  telegramLinkUrls?: string[];
  /**
   * Label for Telegram URL buttons (scenario "link" CTA). If omitted, hostname is used.
   */
  telegramLinkButtonLabel?: string;
  /** Source-grounded clarification options rendered natively when the channel supports it. */
  groundedReplyOptions?: GroundedReplyOption[];
  /** Stable Temporal-owned delivery idempotency key for outbound send retries. */
  temporalDeliveryKey?: string;
  /** Reserved Mongo message id selected during Temporal turn planning. */
  temporalReservedMessageId?: string;
  /** Internal opt-in used only by Temporal delivery activities. */
  temporalDispatchPolicy?: "default" | "at_most_once";
  /** Stable business identity used to recover a deferred Temporal delivery. */
  temporalDispatchIdentity?: string;
  /** Claimed Message owner reused while finalizing a strict dispatch. */
  temporalDispatchOwner?: InstanceType<typeof Message>;
};

type TemporalDispatchState =
  | "reserved"
  | "dispatching"
  | "sent"
  | "not_attempted"
  | "outcome_unknown";

type TemporalDispatchSnapshot = {
  version: 1;
  state: TemporalDispatchState;
  deliveryKey: string;
  attemptToken: string;
  claimedAt?: Date | null;
  finishedAt?: Date | null;
  terminalCode?: string | null;
};

type TemporalDispatchMessage = InstanceType<typeof Message> & {
  temporalDispatch?: TemporalDispatchSnapshot;
  $locals: Record<string, unknown>;
};

class WhatsAppFlowSuppressedError extends Error {
  suppression: ActiveScenarioFlowSuppression;

  constructor(params: {
    flowId: string;
    suppression: ActiveScenarioFlowSuppression;
  }) {
    const reason = params.suppression.errorMessage || params.suppression.reason;
    super(
      `WhatsApp Flow send suppressed for flow "${params.flowId}": ${reason}`
    );
    this.name = "WhatsAppFlowSuppressedError";
    this.suppression = params.suppression;
  }
}


async function assertWhatsAppFlowSendAllowed(
  ctx: OutboundContext,
  flowId: string
) {
  const activeSuppression = await getActiveScenarioFlowSuppression({
    workspaceId: ctx.workspaceId,
    flowId,
  }).catch(error => {
    airiReplyLogger.warn("airi.reply.delivery", {
      conversationId: String(ctx.conversation._id),
      flowId,
      note: "whatsapp_flow_suppression_lookup_failed",
      errorMessage: getWhatsAppFlowErrorMessage(error),
    });
    return null;
  });

  if (!activeSuppression) return;
  airiReplyLogger.info("airi.reply.delivery", {
    conversationId: String(ctx.conversation._id),
    flowId,
    note: "whatsapp_flow_cta_send_suppressed",
    reason: activeSuppression.reason,
    errorCode: activeSuppression.errorCode,
    expiresAt: activeSuppression.expiresAt?.toISOString() || null,
  });
  throw new WhatsAppFlowSuppressedError({
    flowId,
    suppression: activeSuppression,
  });
}

async function throwWhatsAppFlowSendFailure(
  ctx: OutboundContext,
  flowId: string,
  error: unknown
): Promise<never> {
  const message = getWhatsAppFlowErrorMessage(error);
  let recordedIntegritySuppression: ActiveScenarioFlowSuppression | null = null;
  if (isWhatsAppFlowIntegrityBlockError(error)) {
    const suppressedAt = new Date();
    try {
      await suppressScenarioFlowAfterIntegrityBlock({
        workspaceId: ctx.workspaceId,
        sourceId: String(ctx.conversation.sourceId || "") || null,
        conversationId: String(ctx.conversation._id),
        scenarioId:
          ctx.whatsappFlowCta?.scenarioId ||
          ctx.scenarioOrigin?.scenarioId ||
          null,
        actionNodeId:
          ctx.whatsappFlowCta?.actionNodeId ||
          ctx.scenarioOrigin?.actionNodeId ||
          null,
        flowId,
        errorCode: WHATSAPP_FLOW_INTEGRITY_BLOCK_CODE,
        errorMessage: message,
        now: suppressedAt,
      });
      recordedIntegritySuppression = {
        workspaceId: ctx.workspaceId,
        flowId,
        reason: "meta_integrity_block",
        errorCode: WHATSAPP_FLOW_INTEGRITY_BLOCK_CODE,
        errorMessage: message,
        suppressedAt,
        expiresAt: null,
      };
    } catch (suppressionError) {
      airiReplyLogger.warn("airi.reply.delivery", {
        conversationId: String(ctx.conversation._id),
        flowId,
        note: "whatsapp_flow_integrity_suppression_failed",
        errorMessage: getWhatsAppFlowErrorMessage(suppressionError),
      });
    }
  }

  airiReplyLogger.warn("airi.reply.delivery", {
    conversationId: String(ctx.conversation._id),
    flowId,
    note: "whatsapp_flow_cta_send_failed",
    errorMessage: message,
  });

  if (recordedIntegritySuppression) {
    throw new WhatsAppFlowSuppressedError({
      flowId,
      suppression: recordedIntegritySuppression,
    });
  }
  if (error instanceof MetaGraphRequestError) {
    error.message = `WhatsApp Flow send failed for flow "${flowId}": ${message}`;
    throw error;
  }
  throw new Error(`WhatsApp Flow send failed for flow "${flowId}": ${message}`);
}

let airiBotUserPromise: Promise<InstanceType<typeof User> | null> | null = null;

async function resolveAiriBotUser(): Promise<InstanceType<typeof User>> {
  if (!airiBotUserPromise) {
    airiBotUserPromise = User.findOneAndUpdate(
      { _id: 0 },
      { isBot: true, firstName: "Airi", username: "airi" },
      { upsert: true, new: true }
    ).exec();
  }

  try {
    const botUser = await airiBotUserPromise;
    if (!botUser) {
      airiBotUserPromise = null;
      throw new Error("Failed to resolve bot user");
    }
    return botUser;
  } catch (error) {
    airiBotUserPromise = null;
    throw error;
  }
}

type WhatsAppOutboundInfo = {
  phoneNumberId: string;
  accessToken: string;
  messagingAccountId?: string;
  wabaId?: string;
  contactData: WhatsAppNormalizedContact;
};

function asNonEmptyString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || undefined;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "object" && "_id" in value) {
    return asNonEmptyString((value as { _id?: unknown })._id);
  }
  if (typeof (value as { toString?: unknown })?.toString === "function") {
    const normalized = String(value).trim();
    return normalized && normalized !== "[object Object]"
      ? normalized
      : undefined;
  }
  return undefined;
}

/** The connection this conversation's replies go out from. */
function resolveOutboundSourceId(
  ctx: Pick<OutboundContext, "workspaceId" | "conversation" | "chatDocument">
): string | undefined {
  return (
    resolveConversationReplySourceId({
      workspaceId: ctx.workspaceId,
      conversation: ctx.conversation,
      chat: ctx.chatDocument,
    }) || undefined
  );
}

function whatsappFlowRequiresBoundSource(
  flowConfig: WhatsAppFlowConfig | null | undefined
): boolean {
  return resolveWhatsAppFlowSourceBinding({ flowConfig }) !== "unmanaged";
}

function assertWhatsAppFlowOutboundSource(params: {
  ctx: OutboundContext;
  flowConfig?: WhatsAppFlowConfig | null;
  managedSourceId?: string | null;
  managedWabaId?: string | null;
  outboundWabaId?: string | null;
}): string | undefined {
  const chatSourceId =
    resolveWorkspaceChatSourceId({
      workspaceId: params.ctx.workspaceId,
      conversation: params.ctx.conversation,
      chat: params.ctx.chatDocument,
    }) || undefined;
  const conversationSourceId = asNonEmptyString(
    params.ctx.conversation?.sourceId
  );
  const outboundSourceId = chatSourceId || conversationSourceId;
  const binding = resolveWhatsAppFlowSourceBinding({
    flowConfig: params.flowConfig,
    managedSourceId: params.managedSourceId,
    managedWabaId: params.managedWabaId,
    outboundSourceId,
    outboundWabaId: params.outboundWabaId,
  });
  if (binding === "unmanaged") return undefined;

  if (
    chatSourceId &&
    conversationSourceId &&
    chatSourceId !== conversationSourceId
  ) {
    throw new Error(
      "WhatsApp Flow outbound chat and conversation sources do not match"
    );
  }

  if (binding !== "matched") {
    throw new Error("WhatsApp Flow source does not match outbound source");
  }
  return outboundSourceId;
}

function readObjectString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return asNonEmptyString((value as Record<string, unknown>)[key]);
}

function resolveOutboundWhatsAppContact(
  ctx: OutboundContext
): WhatsAppNormalizedContact | null {
  if (ctx.whatsAppInfo?.contactData) {
    return ctx.whatsAppInfo.contactData;
  }

  const recipientTarget = resolveStoredWhatsAppRecipientTarget(
    ctx.conversation?.user,
    ctx.conversation?.chat,
    ctx.chatDocument
  );
  if (!recipientTarget) {
    return null;
  }

  const chatWhatsApp =
    ctx.chatDocument &&
    typeof ctx.chatDocument === "object" &&
    "whatsapp" in ctx.chatDocument
      ? (ctx.chatDocument as { whatsapp?: unknown }).whatsapp
      : null;
  const profileName =
    readObjectString(chatWhatsApp, "profileName") ||
    readObjectString(ctx.chatDocument, "first_name") ||
    readObjectString(ctx.chatDocument, "title") ||
    readObjectString(ctx.chatDocument, "username") ||
    "Customer";
  const username =
    readObjectString(chatWhatsApp, "username") ||
    readObjectString(ctx.chatDocument, "username");

  return buildNormalizedWhatsAppContact({
    waId: recipientTarget.kind === "phone" ? recipientTarget.value : undefined,
    userId:
      recipientTarget.kind === "bsuid" ? recipientTarget.value : undefined,
    parentUserId:
      recipientTarget.kind === "parent_bsuid"
        ? recipientTarget.value
        : undefined,
    profileName,
    username,
  });
}

const MIN_WHATSAPP_FEEDBACK_TESTER_PHONE_DIGITS = 7;

function digitsOnlyPhone(value: unknown): string {
  return String(value || "").replace(/[^0-9]/g, "");
}

function isWhatsAppFeedbackTesterPhone(
  recipient: string,
  tester: string
): boolean {
  if (!recipient || tester.length < MIN_WHATSAPP_FEEDBACK_TESTER_PHONE_DIGITS) {
    return false;
  }
  return (
    recipient === tester ||
    recipient.endsWith(tester) ||
    tester.endsWith(recipient)
  );
}

/**
 * Resolve digits for tester allowlist. Prefer contact/waId over chatId —
 * chatId may be `wa_<phone>` (ok) or a non-phone id that strips poorly.
 */
function resolveWhatsAppFeedbackRecipientDigits(ctx: OutboundContext): string {
  const contact = resolveOutboundWhatsAppContact(ctx);
  const recipientTarget = resolveWhatsAppRecipientTarget(contact);
  const chatWhatsApp =
    ctx.chatDocument &&
    typeof ctx.chatDocument === "object" &&
    "whatsapp" in ctx.chatDocument
      ? (ctx.chatDocument as { whatsapp?: Record<string, unknown> }).whatsapp
      : null;

  const candidates = [
    recipientTarget?.kind === "phone" ? recipientTarget.value : null,
    contact && "waId" in contact ? (contact as { waId?: unknown }).waId : null,
    chatWhatsApp?.waId,
    typeof ctx.chatDocument?._id === "string" ? ctx.chatDocument._id : null,
    ctx.chatId,
  ];

  for (const candidate of candidates) {
    const digits = digitsOnlyPhone(candidate);
    if (digits.length >= MIN_WHATSAPP_FEEDBACK_TESTER_PHONE_DIGITS) {
      return digits;
    }
  }
  return "";
}

function evaluateWhatsAppLlmFeedbackPrompt(ctx: OutboundContext): {
  allowed: boolean;
  reason: string;
  recipientDigits: string;
} {
  if (ctx.type !== "whatsapp") {
    return { allowed: false, reason: "not_whatsapp", recipientDigits: "" };
  }

  const recipientDigits = resolveWhatsAppFeedbackRecipientDigits(ctx);
  const raw = String(process.env.LLM_WHATSAPP_FEEDBACK_PROMPT_ENABLED || "");
  if (!["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())) {
    return {
      allowed: false,
      reason: "prompt_disabled",
      recipientDigits,
    };
  }

  const testersRaw = String(process.env.LLM_WHATSAPP_FEEDBACK_TESTERS || "");
  if (testersRaw.trim()) {
    const testers = testersRaw
      .split(",")
      .map(num => digitsOnlyPhone(num.trim()))
      .filter(
        tester => tester.length >= MIN_WHATSAPP_FEEDBACK_TESTER_PHONE_DIGITS
      );
    const isTester = testers.some(tester =>
      isWhatsAppFeedbackTesterPhone(recipientDigits, tester)
    );
    if (!isTester) {
      return { allowed: false, reason: "not_tester", recipientDigits };
    }
  }

  if (ctx.whatsappTemplate || ctx.whatsappFlowCta || ctx.whatsappCtaLink) {
    return {
      allowed: false,
      reason: "interactive_or_template_payload",
      recipientDigits,
    };
  }
  if (ctx.whatsappServiceMessage) {
    return {
      allowed: false,
      reason: "service_message_payload",
      recipientDigits,
    };
  }
  if (ctx.groundedReplyOptions?.length) {
    return {
      allowed: false,
      reason: "grounded_reply_options_payload",
      recipientDigits,
    };
  }

  return { allowed: true, reason: "allowed", recipientDigits };
}

/**
 * Build a Temporal post-delivery effect for WhatsApp tester feedback.
 * Call during prepare (after outbound capture) so deliver/finalize retries
 * still send the prompt even when Meta send already persisted.
 */
export function buildWhatsAppLlmFeedbackPostDeliveryEffect(
  ctx: OutboundContext
): Extract<
  AiriConversationPostDeliveryEffect,
  { kind: "send_whatsapp_llm_feedback" }
> | null {
  const gate = evaluateWhatsAppLlmFeedbackPrompt(ctx);
  if (!gate.allowed) {
    return null;
  }

  const recipient = resolveWhatsAppRecipientTarget(
    resolveOutboundWhatsAppContact(ctx)
  );
  if (!recipient) {
    return null;
  }

  return {
    kind: "send_whatsapp_llm_feedback",
    payload: {
      workspaceId: String(ctx.workspaceId),
      conversationId: String(ctx.conversation._id),
      sourceId: resolveOutboundSourceId(ctx) || null,
      recipient,
      recipientDigits: gate.recipientDigits || null,
    },
  };
}

async function resolveOutboundWhatsAppInfo(
  ctx: OutboundContext,
  options: { requireFreshSource?: boolean } = {}
): Promise<WhatsAppOutboundInfo | undefined> {
  if (
    !options.requireFreshSource &&
    ctx.whatsAppInfo?.phoneNumberId &&
    ctx.whatsAppInfo.accessToken
  ) {
    const contactData = resolveOutboundWhatsAppContact(ctx);
    if (!contactData) return undefined;
    return {
      phoneNumberId: ctx.whatsAppInfo.phoneNumberId,
      accessToken: ctx.whatsAppInfo.accessToken,
      messagingAccountId: asNonEmptyString(ctx.whatsAppInfo.messagingAccountId),
      wabaId: asNonEmptyString(ctx.whatsAppInfo.wabaId),
      contactData,
    };
  }

  const resolveContext = options.requireFreshSource
    ? resolveFreshWhatsAppSendContext
    : resolveWhatsAppSendContext;
  const sendContext = await resolveContext({
    workspaceId: ctx.workspaceId,
    sourceId: ctx.behaviorRun?.sourceId || resolveOutboundSourceId(ctx),
  });
  const contactData = resolveOutboundWhatsAppContact(ctx);
  if (!sendContext || !contactData) {
    return undefined;
  }
  if (
    ctx.behaviorRun &&
    (sendContext.attributionBoundaryAt === null ||
      (sendContext.attributionBoundaryAt !== undefined &&
        Date.parse(sendContext.attributionBoundaryAt) >
          new Date(ctx.behaviorRun.occurredAt).getTime()))
  ) {
    return undefined;
  }

  return {
    phoneNumberId: sendContext.phoneNumberId,
    accessToken: sendContext.accessToken,
    messagingAccountId: sendContext.messagingAccountId,
    wabaId: sendContext.wabaId,
    contactData,
  };
}

/** Credentials plus recipient for a direct WhatsApp send; both are required. */
async function requireWhatsAppTransport(
  ctx: OutboundContext,
  requireFreshSource: boolean
) {
  const whatsAppInfo = await resolveOutboundWhatsAppInfo(ctx, {
    requireFreshSource,
  });
  if (!whatsAppInfo) throw new Error("Missing WhatsApp config");
  const recipientTarget = resolveWhatsAppRecipientTarget(
    whatsAppInfo.contactData
  );
  if (!recipientTarget) throw new Error("Missing WhatsApp recipient target");
  return { whatsAppInfo, recipientTarget };
}

function normalizeGroundedReplyOptions(
  value: OutboundContext["groundedReplyOptions"]
): GroundedReplyOption[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: GroundedReplyOption[] = [];
  const seen = new Set<string>();
  const seenCallbackKeys = new Set<string>();

  for (const option of value) {
    const id = String(option?.id || "").trim();
    const label = String(option?.label || "").trim();
    const sourceKind =
      option?.sourceKind === "snippet" ||
      option?.sourceKind === "kb" ||
      option?.sourceKind === "mixed"
        ? option.sourceKind
        : null;
    const sourceIds = Array.from(
      new Set(
        (Array.isArray(option?.sourceIds) ? option.sourceIds : [])
          .map(item => String(item || "").trim())
          .filter(Boolean)
      )
    ).slice(0, 8);

    if (
      !id ||
      !label ||
      !sourceKind ||
      sourceIds.length === 0 ||
      seen.has(id)
    ) {
      continue;
    }

    seen.add(id);
    const rawCallbackKey =
      typeof option.callbackKey === "string" && option.callbackKey.trim()
        ? option.callbackKey.trim()
        : "";
    let callbackKey =
      rawCallbackKey && Buffer.byteLength(rawCallbackKey, "utf8") <= 24
        ? rawCallbackKey
        : buildGroundedReplyOptionCallbackKey(normalized.length);
    if (seenCallbackKeys.has(callbackKey)) {
      let fallbackIndex = normalized.length;
      do {
        callbackKey = buildGroundedReplyOptionCallbackKey(fallbackIndex);
        fallbackIndex += 1;
      } while (seenCallbackKeys.has(callbackKey));
    }
    seenCallbackKeys.add(callbackKey);

    normalized.push({
      id,
      callbackKey,
      label,
      description:
        typeof option.description === "string" && option.description.trim()
          ? option.description.trim()
          : null,
      selectionKind:
        option.selectionKind === "offer" ||
        option.selectionKind === "program" ||
        option.selectionKind === "payment" ||
        option.selectionKind === "product"
          ? option.selectionKind
          : null,
      sourceKind,
      sourceIds,
      sourceRecordId:
        typeof option.sourceRecordId === "string" &&
        option.sourceRecordId.trim()
          ? option.sourceRecordId.trim()
          : null,
      sourceDocumentId:
        typeof option.sourceDocumentId === "string" &&
        option.sourceDocumentId.trim()
          ? option.sourceDocumentId.trim()
          : null,
      quotedPriceText:
        typeof option.quotedPriceText === "string" &&
        option.quotedPriceText.trim()
          ? option.quotedPriceText.trim()
          : null,
      quotedPriceAmount:
        typeof option.quotedPriceAmount === "number"
          ? option.quotedPriceAmount
          : null,
      quotedPriceCurrency:
        typeof option.quotedPriceCurrency === "string" &&
        option.quotedPriceCurrency.trim()
          ? option.quotedPriceCurrency.trim()
          : null,
    });
  }

  return normalized.slice(0, 4);
}

function resolveGroundedReplyOptionSurface(
  channel: Channel,
  options: GroundedReplyOption[]
): StoredGroundedReplyOptionsPreview["surface"] {
  if (options.length === 0) {
    return null;
  }
  if (channel === "telegram") {
    return "telegram_inline";
  }
  if (channel === "whatsapp") {
    return options.length <= 3 ? "whatsapp_button" : "whatsapp_list";
  }
  return "text";
}

function buildStoredGroundedReplyOptionsPreview(params: {
  channel: Channel;
  options: GroundedReplyOption[];
}): StoredGroundedReplyOptionsPreview | null {
  const options = normalizeGroundedReplyOptions(params.options);
  if (options.length === 0) {
    return null;
  }

  return {
    surface: resolveGroundedReplyOptionSurface(params.channel, options),
    options,
  };
}

export function resolveWhatsAppVoiceReplyIntent(params: {
  channel: string;
  enabled: boolean;
  inboundMediaType: string;
  text: string;
  language?: string | null;
  grounded: boolean;
  hasScenario?: boolean;
  hasInteractivePayload?: boolean;
  hasAttachments?: boolean;
  proactive?: boolean;
}): OutboundContext["whatsappVoiceReply"] {
  const text = params.text.trim();
  if (
    params.channel !== "whatsapp" ||
    !params.enabled ||
    !["audio", "voice"].includes(params.inboundMediaType.toLowerCase()) ||
    !params.grounded ||
    !text ||
    text.length > WHATSAPP_VOICE_REPLY_MAX_CHARACTERS ||
    params.hasScenario ||
    params.hasInteractivePayload ||
    params.hasAttachments ||
    params.proactive
  ) {
    return undefined;
  }
  return { language: params.language };
}

function canPrepareWhatsAppVoiceReply(ctx: OutboundContext): boolean {
  return Boolean(
    ctx.type === "whatsapp" &&
      ctx.whatsappVoiceReply &&
      !ctx.scenarioOrigin &&
      !ctx.behaviorRun &&
      !ctx.whatsappTemplate &&
      !ctx.whatsappServiceMessage &&
      !ctx.whatsappFlowCta &&
      !ctx.whatsappCtaLink &&
      !ctx.groundedReplyOptions?.length &&
      !ctx.whatsappServiceAppointmentChoices?.length &&
      !ctx.scenarioAttachments?.length &&
      !ctx.scenarioImageUrls?.length
  );
}

async function prepareWhatsAppVoiceReplyAttachment(
  ctx: OutboundContext
): Promise<{
  attachment: ScenarioActionAttachment;
  preview: WhatsAppServiceMessagePreview;
} | null> {
  if (!canPrepareWhatsAppVoiceReply(ctx)) return null;
  const deliveryKey = (
    ctx.temporalDeliveryKey ||
    ctx.sourceMessageId ||
    ""
  ).trim();
  if (!deliveryKey) return null;
  try {
    const attachment = await prepareWhatsAppVoiceReply({
      workspaceId: ctx.workspaceId,
      deliveryKey,
      text: stripAiriPrefix(ctx.content),
      language: ctx.whatsappVoiceReply?.language,
    });
    if (!attachment || attachment.mediaType !== "audio") return null;
    const compiled = compileWhatsAppServiceMessage({
      recipientKind:
        resolveWhatsAppRecipientTarget(resolveOutboundWhatsAppContact(ctx))
          ?.kind === "phone"
          ? "phone"
          : "bsuid",
      config: {
        version: 1,
        message: { kind: "media", attachment, deliverAsVoice: true },
      },
    });
    if (!compiled.ok) return null;
    return {
      attachment: await resolveScenarioActionAttachmentHttpsUrl({
        workspaceId: ctx.workspaceId,
        attachment,
      }),
      preview: compiled.preview,
    };
  } catch {
    // No Meta dispatch has happened. The original text remains deliverable.
    return null;
  }
}

export async function sendAndPersistOutbound(ctx: OutboundContext) {
  const captureContext =
    !ctx.temporalDeliveryKey && !ctx.temporalReservedMessageId
      ? tryCaptureTemporalOutbound(ctx)
      : null;
  if (captureContext) {
    return captureContext;
  }

  if (
    ctx.whatsappVoiceReply &&
    ctx.temporalDispatchPolicy === "at_most_once" &&
    !ctx.temporalDeliveryKey &&
    !ctx.temporalReservedMessageId
  ) {
    // Legacy direct callers have no durable dispatch owner for generated audio.
    ctx = {
      ...ctx,
      whatsappVoiceReply: undefined,
      temporalDispatchPolicy: undefined,
    };
  }

  if (
    ctx.type === "whatsapp" &&
    ctx.sourceMessageId &&
    ctx.scenarioOrigin?.scenarioId
  ) {
    const { findOutboundBehaviorRun } = await import(
      "@/lib/scenarios/behavior-delivery"
    );
    const run = await findOutboundBehaviorRun({
      workspaceId: ctx.workspaceId,
      conversationId: String(ctx.conversation._id),
      scenarioId: ctx.scenarioOrigin.scenarioId,
      sourceMessageId: ctx.sourceMessageId,
      behaviorRunId: ctx.behaviorRunId,
    });
    if (run)
      return sendAndPersistAtMostOnceOutbound({ ...ctx, behaviorRun: run });
  }

  if (
    ctx.temporalDispatchPolicy === "at_most_once" ||
    (ctx.type === "whatsapp" &&
      (ctx.whatsappTemplate?.name?.trim() || ctx.whatsappServiceMessage) &&
      ctx.temporalDeliveryKey &&
      ctx.temporalReservedMessageId) ||
    (canPrepareWhatsAppVoiceReply(ctx) &&
      ctx.temporalDeliveryKey &&
      ctx.temporalReservedMessageId)
  ) {
    return sendAndPersistAtMostOnceOutbound(ctx);
  }

  return sendAndPersistOutboundDefault(ctx);
}

class TemporalDispatchNotAttemptedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TemporalDispatchNotAttemptedError";
    this.code = code;
  }
}

function buildTemporalDispatchSnapshot(params: {
  owner: TemporalDispatchMessage;
  state: TemporalDispatchState;
  now: Date;
  terminalCode?: string;
}): TemporalDispatchSnapshot {
  const current = params.owner.temporalDispatch;
  if (!current) {
    throw new Error("Temporal dispatch owner is missing private state");
  }

  return {
    version: 1,
    state: params.state,
    deliveryKey: current.deliveryKey,
    attemptToken: current.attemptToken,
    ...(current.claimedAt ? { claimedAt: current.claimedAt } : {}),
    ...(params.state === "dispatching"
      ? { claimedAt: params.now }
      : params.state !== "reserved"
        ? { finishedAt: params.now }
        : {}),
    ...(params.terminalCode
      ? { terminalCode: params.terminalCode.slice(0, 64) }
      : {}),
  };
}

async function findTemporalDispatchOwner(
  ctx: Pick<
    OutboundContext,
    "temporalDeliveryKey" | "temporalReservedMessageId"
  >
): Promise<TemporalDispatchMessage | null> {
  const deliveryKey = String(ctx.temporalDeliveryKey || "").trim();
  const reservedMessageId = String(ctx.temporalReservedMessageId || "").trim();
  if (!deliveryKey || !reservedMessageId) return null;

  const owner = (await Message.findOne({
    _id: reservedMessageId,
    ...buildTemporalDeliveryKeyFilter(deliveryKey),
  }).select("+temporalDispatch")) as TemporalDispatchMessage | null;
  if (
    owner?.temporalDispatch &&
    owner.temporalDispatch.deliveryKey !== deliveryKey
  ) {
    throw new Error("Temporal dispatch identity does not match private owner");
  }
  return owner;
}

async function hasTemporalDispatchIdentityCollision(
  ctx: { temporalDeliveryKey: string; temporalReservedMessageId: string }
): Promise<boolean> {
  const collision = await Message.findOne({
    $or: [
      { _id: ctx.temporalReservedMessageId },
      buildTemporalDeliveryKeyFilter(ctx.temporalDeliveryKey),
    ],
  }).select("_id");
  return Boolean(collision);
}

async function reserveTemporalDispatchOwner(
  ctx: OutboundContext
): Promise<TemporalDispatchMessage> {
  const deliveryKey = String(ctx.temporalDeliveryKey || "").trim();
  const reservedMessageId = String(ctx.temporalReservedMessageId || "").trim();
  if (!deliveryKey || !reservedMessageId) {
    throw new Error(
      "at_most_once dispatch requires temporalDeliveryKey and temporalReservedMessageId"
    );
  }

  const existing = await findTemporalDispatchOwner(ctx);
  if (existing) {
    if (!existing.temporalDispatch) {
      existing.temporalDispatch = {
        version: 1,
        state: "sent",
        deliveryKey,
        attemptToken: `recovered:${reservedMessageId}`,
        finishedAt: existing.date || new Date(),
      };
    }
    return existing;
  }
  if (
    await hasTemporalDispatchIdentityCollision({
      temporalDeliveryKey: deliveryKey,
      temporalReservedMessageId: reservedMessageId,
    })
  ) {
    throw new Error(
      "Temporal dispatch identity collision: reserved id and delivery key must match one owner"
    );
  }

  const owner = new Message({
    _id: reservedMessageId,
    temporalDeliveryKey: deliveryKey,
    temporalDispatch: {
      version: 1,
      state: "reserved",
      deliveryKey,
      attemptToken: randomUUID(),
    },
  }) as TemporalDispatchMessage;

  try {
    await owner.save();
    return owner;
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) {
      throw error;
    }
    const racedOwner = await findTemporalDispatchOwner(ctx);
    if (!racedOwner) {
      throw new Error(
        "Temporal dispatch identity collision after reservation race"
      );
    }
    return racedOwner;
  }
}

type StrictWhatsAppTransportPlan = {
  authorId: unknown;
  text: string;
  attachment?: ScenarioActionAttachment;
  templatePreview?: ReturnType<typeof buildStoredWhatsAppTemplatePreview>;
  claimAtProviderBoundary?: boolean;
  dispatch: (beforeSend?: () => Promise<void>) => Promise<{
    messageId?: string;
    servicePreview?: WhatsAppServiceMessagePreview;
    primaryMedia?: WhatsAppScenarioPrimaryMedia;
    flowTokenUsed?: string;
    templatePreview?: ReturnType<
      typeof buildStoredWhatsAppTemplatePreview
    > | null;
  }>;
};

async function prepareAtMostOnceWhatsAppTransport(
  ctx: OutboundContext
): Promise<StrictWhatsAppTransportPlan> {
  if (
    ctx.type !== "whatsapp" ||
    (!ctx.whatsappTemplate &&
      !ctx.whatsappServiceMessage &&
      (ctx.whatsappFlowCta ||
        ctx.whatsappCtaLink ||
        ctx.groundedReplyOptions?.length ||
        ctx.whatsappServiceAppointmentChoices?.length))
  ) {
    throw new TemporalDispatchNotAttemptedError(
      "unsupported_strict_payload",
      "at_most_once supports one WhatsApp text or media transport"
    );
  }
  const attachments = normalizeScenarioActionAttachments({
    attachments: ctx.scenarioAttachments,
    legacyUrls: ctx.scenarioImageUrls,
    limit: MAX_SCENARIO_REPLY_IMAGES,
  });
  if (
    !ctx.whatsappTemplate &&
    !ctx.whatsappServiceMessage &&
    attachments.length > 1
  ) {
    throw new TemporalDispatchNotAttemptedError(
      "unsupported_strict_payload",
      "at_most_once cannot dispatch multiple provider messages"
    );
  }
  const whatsAppInfo = await resolveOutboundWhatsAppInfo(ctx, {
    requireFreshSource: Boolean(ctx.behaviorRun),
  });
  if (!whatsAppInfo) {
    throw new TemporalDispatchNotAttemptedError(
      "missing_whatsapp_config",
      "Missing WhatsApp config"
    );
  }
  const recipient = resolveWhatsAppRecipientTarget(whatsAppInfo.contactData);
  if (!recipient) {
    throw new TemporalDispatchNotAttemptedError(
      "missing_whatsapp_recipient",
      "Missing WhatsApp recipient target"
    );
  }
  if (ctx.whatsappTemplate && !ctx.whatsappServiceMessage) {
    const template = ctx.whatsappTemplate;
    if (ctx.behaviorRun) {
      const { WhatsAppTemplateModel } = await import(
        "@/models/whatsapp-template"
      );
      const meta = await WhatsAppTemplateModel.findOne({
        workspaceId: ctx.workspaceId,
        name: template.name,
        language: template.languageCode || "en",
        status: "APPROVED",
        category: { $in: ["MARKETING", "UTILITY"] },
      }).lean<{ components: unknown[] }>();
      if (!meta)
        throw new TemporalDispatchNotAttemptedError(
          "template_unavailable",
          "Approved template required"
        );
    }
    return {
      authorId: (await resolveAiriBotUser())._id,
      text: String(ctx.content || "").trim() || `[Template: ${template.name}]`,
      claimAtProviderBoundary: true,
      dispatch: async beforeSend => {
        const result = await handleWhatsAppTemplateSend(
          ctx,
          template,
          beforeSend
        );
        return {
          messageId: result.id,
          templatePreview: result.templatePreview,
        };
      },
    };
  }
  const window = await checkMessagingWindowForConversation(ctx.conversation);
  if (!window.isWithinWindow) {
    throw new TemporalDispatchNotAttemptedError(
      "service_window_closed",
      "WhatsApp customer-service window is closed"
    );
  }
  const text = formatReplyMarkdownForWhatsApp(String(ctx.content || "").trim());
  const authorId = (await resolveAiriBotUser())._id;
  if (ctx.whatsappServiceMessage) {
    const config = ctx.whatsappServiceMessage;
    return {
      authorId,
      text,
      claimAtProviderBoundary: true,
      dispatch: async beforeSend => {
        const result = await handleWhatsAppServiceMessageSend(
          { ...ctx, whatsAppInfo },
          config,
          text,
          beforeSend
        );
        return {
          messageId: result.id,
          servicePreview: result.preview,
          primaryMedia: result.primaryMedia,
          flowTokenUsed: result.flowTokenUsed,
        };
      },
    };
  }
  const voiceReply = await prepareWhatsAppVoiceReplyAttachment(ctx);
  const voiceAttachment = voiceReply?.attachment;
  const attachment =
    voiceAttachment ||
    (attachments[0]
      ? await resolveScenarioActionAttachmentHttpsUrl({
          workspaceId: ctx.workspaceId,
          attachment: attachments[0],
        })
      : undefined);
  if (attachments[0] && !attachment) {
    throw new TemporalDispatchNotAttemptedError(
      "invalid_media_attachment",
      "Strict media attachment could not be resolved"
    );
  }
  if (!text && !attachment) {
    throw new TemporalDispatchNotAttemptedError(
      "no_outbound_content",
      "No outbound content was provided"
    );
  }

  return attachment
    ? {
        authorId,
        text,
        attachment,
        dispatch: async () => {
          const result = await whatsappApi.sendWhatsappMedia(
            whatsAppInfo.phoneNumberId,
            whatsAppInfo.accessToken,
            recipient,
            {
              type: attachment.mediaType,
              link: attachment.url,
              caption: text || undefined,
              fileName: attachment.fileName,
              ...(voiceAttachment ? { voice: true } : {}),
            }
          );
          return {
            messageId: result.messageId?.toString(),
            ...(voiceReply ? { servicePreview: voiceReply.preview } : {}),
          };
        },
      }
    : {
        authorId,
        text,
        dispatch: async () => {
          const result = await whatsappApi.sendWhatsappMessage(
            whatsAppInfo.phoneNumberId,
            whatsAppInfo.accessToken,
            recipient,
            text
          );
          return { messageId: result.messageId?.toString() };
        },
      };
}

async function transitionTemporalDispatchOwner(params: {
  owner: TemporalDispatchMessage;
  expectedState: TemporalDispatchState;
  nextState: TemporalDispatchState;
  terminalCode?: string;
}): Promise<TemporalDispatchMessage | null> {
  const current = params.owner.temporalDispatch;
  if (!current) return null;
  const next = buildTemporalDispatchSnapshot({
    owner: params.owner,
    state: params.nextState,
    now: new Date(),
    terminalCode: params.terminalCode,
  });

  return (await Message.findOneAndUpdate(
    {
      _id: params.owner._id,
      ...buildTemporalDeliveryKeyFilter(current.deliveryKey),
      "temporalDispatch.state": params.expectedState,
      "temporalDispatch.attemptToken": current.attemptToken,
    },
    { $set: { temporalDispatch: next } },
    { new: true }
  ).select("+temporalDispatch")) as TemporalDispatchMessage | null;
}

async function sendAndPersistAtMostOnceOutbound(
  ctx: OutboundContext
): Promise<TemporalDispatchMessage> {
  let owner = await reserveTemporalDispatchOwner(ctx);
  const state = owner.temporalDispatch?.state;
  if (state !== "reserved") {
    return owner;
  }

  let transportPlan: StrictWhatsAppTransportPlan;
  try {
    transportPlan = await prepareAtMostOnceWhatsAppTransport(ctx);
    // Validate the full transport before consuming contact capacity. Revalidate
    // the cart and sales after preparation, immediately before the dispatch claim.
    if (ctx.behaviorRun) {
      const { guardBehaviorDelivery } = await import(
        "@/lib/scenarios/behavior-delivery"
      );
      const info = await resolveOutboundWhatsAppInfo(ctx, {
        requireFreshSource: true,
      });
      const recipient =
        info && resolveWhatsAppRecipientTarget(info.contactData);
      const reason = await guardBehaviorDelivery(
        ctx.behaviorRun,
        recipient?.kind === "phone" ? recipient.value : "",
        ctx.temporalDeliveryKey || ""
      );
      if (reason) throw new TemporalDispatchNotAttemptedError(reason, reason);
    }
  } catch (error) {
    if (!(error instanceof TemporalDispatchNotAttemptedError)) {
      throw new AiriOutboundPreparationFailedError(
        error instanceof Error ? error.message : String(error)
      );
    }
    return (
      (await transitionTemporalDispatchOwner({
        owner,
        expectedState: "reserved",
        nextState: "not_attempted",
        terminalCode: error.code,
      })) ||
      (await findTemporalDispatchOwner(ctx)) ||
      owner
    );
  }

  let dispatchClaimed = false;
  let providerAccepted = false;
  const claimDispatch = async () => {
    const scenarioId =
      ctx.scenarioOrigin?.scenarioId || ctx.whatsappFlowCta?.scenarioId;
    if (scenarioId && !ctx.behaviorRun) {
      const { Conversation } = await import("@/models/conversation");
      const currentConversation = await Conversation.findOne({
        _id: ctx.conversation._id,
        workspaceId: ctx.workspaceId,
      })
        .select(
          "last_inbound_at airi_handoff_active airi_handoff_started_at airi_scenario_state"
        )
        .lean();
      const ownership = resolveScenarioDeliveryOwnership({
        capturedConversation: ctx.conversation,
        currentConversation,
        scenarioId,
        actionNodeId:
          ctx.scenarioOrigin?.actionNodeId ||
          ctx.whatsappFlowCta?.actionNodeId ||
          "",
        capturedMessageDate: ctx.newMessage?.date,
      });
      if (!ownership.allow) {
        throw new TemporalDispatchNotAttemptedError(
          ownership.reason,
          ownership.reason
        );
      }
    }
    const claimed = await transitionTemporalDispatchOwner({
      owner,
      expectedState: "reserved",
      nextState: "dispatching",
    });
    if (!claimed) throw new Error("Temporal dispatch already claimed");
    owner = claimed;
    dispatchClaimed = true;
    if (ctx.behaviorRun) {
      const { markBehaviorContactAttempted } = await import(
        "@/lib/scenarios/behavior-delivery"
      );
      await markBehaviorContactAttempted(ctx.behaviorRun);
    }
  };

  try {
    if (!transportPlan.claimAtProviderBoundary) await claimDispatch();
    const providerResult = await transportPlan.dispatch(claimDispatch);
    providerAccepted = true;
    const sentAt = new Date();
    const outbound = (await persistOutboundRecord(
      {
        ...ctx,
        temporalDispatchOwner: owner,
      },
      {
        messageId: providerResult.messageId
          ? normalizeWhatsAppMessageId(providerResult.messageId)
          : undefined,
        text: transportPlan.text || "[outbound]",
        date: sentAt,
        authorId: transportPlan.authorId,
        ...(providerResult.templatePreview || transportPlan.templatePreview
          ? {
              whatsappTemplate:
                providerResult.templatePreview || transportPlan.templatePreview,
            }
          : {}),
        ...(providerResult.servicePreview
          ? { whatsappServiceMessage: providerResult.servicePreview }
          : {}),
        imageUrl:
          providerResult.primaryMedia?.url || transportPlan.attachment?.url,
        mediaType:
          providerResult.primaryMedia?.mediaType ||
          transportPlan.attachment?.mediaType,
        ...(ctx.whatsappTemplate
          ? {
              whatsappFlow: buildStoredOutboundWhatsAppFlow(
                ctx,
                transportPlan.text
              ),
            }
          : {}),
      }
    )) as TemporalDispatchMessage;
    if (ctx.whatsappTemplate || ctx.whatsappServiceMessage) {
      await trackOutboundWhatsAppFlow(ctx, {
        servicePreview: providerResult.servicePreview,
        usedFlowToken: providerResult.flowTokenUsed,
        platformMessageId: providerResult.messageId,
        sentAt,
      });
    }
    return outbound;
  } catch (error) {
    const current = await findTemporalDispatchOwner(ctx);
    if (current?.temporalDispatch?.state === "sent") {
      return current;
    }
    if (!dispatchClaimed) {
      // Template download/upload and payload preparation have not crossed the
      // messages endpoint boundary. Another activity can still own the CAS.
      if (current?.temporalDispatch?.state === "reserved") {
        if (error instanceof TemporalDispatchNotAttemptedError) {
          return (
            (await transitionTemporalDispatchOwner({
              owner: current,
              expectedState: "reserved",
              nextState: "not_attempted",
              terminalCode: error.code,
            })) ||
            (await findTemporalDispatchOwner(ctx)) ||
            current
          );
        }
        throw new AiriOutboundPreparationFailedError(
          error instanceof Error ? error.message : String(error)
        );
      }
      return current || owner;
    }
    if (!providerAccepted && isRetryableWhatsAppProviderRejection(error)) {
      const released = await transitionTemporalDispatchOwner({
        owner: current || owner,
        expectedState: "dispatching",
        nextState: "reserved",
        terminalCode: "provider_rejected_131000",
      });
      if (released) throw new AiriOutboundProviderRejectedError(error.message);
      return (await findTemporalDispatchOwner(ctx)) || current || owner;
    }
    return (
      (await transitionTemporalDispatchOwner({
        owner: current || owner,
        expectedState: "dispatching",
        nextState: "outcome_unknown",
        terminalCode: "provider_outcome_unknown",
      })) ||
      current ||
      owner
    );
  }
}

function isRetryableWhatsAppProviderRejection(
  error: unknown
): error is MetaGraphRequestError {
  if (
    !(error instanceof MetaGraphRequestError) ||
    !Number.isInteger(error.status) ||
    error.status < 400 ||
    error.status > 599 ||
    !error.details ||
    typeof error.details !== "object"
  )
    return false;
  const response = error.details as {
    error?: { code?: unknown };
    messages?: Array<{ id?: unknown }>;
  };
  return (
    response.error?.code === 131000 &&
    (response.messages === undefined ||
      (Array.isArray(response.messages) &&
        !response.messages.some(message => Boolean(message?.id))))
  );
}

function buildStoredOutboundWhatsAppFlow(
  ctx: OutboundContext,
  text: string,
  usedFlowToken?: string
) {
  const flow = !ctx.whatsappServiceMessage ? ctx.whatsappFlowCta : undefined;
  if (ctx.type !== "whatsapp" || (!flow?.flowId && !flow?.flowName))
    return null;
  return {
    flowId: flow.flowId || null,
    flowName: flow.flowName || null,
    flowToken: usedFlowToken || flow.flowToken || null,
    flowCta: flow.flowCta || "Open flow",
    headerText: flow.headerText || null,
    bodyText: text || null,
    footerText: flow.footerText || null,
    responseFieldMetadata: flow.responseFieldMetadata || null,
    flowActionType: flow.flowActionType || null,
    flowActionPayload: flow.flowActionPayload || null,
    scenarioId: flow.scenarioId || null,
    scenarioName: flow.scenarioName || null,
    actionNodeId: flow.actionNodeId || null,
    status: "sent" as const,
  };
}

async function trackOutboundWhatsAppFlow(
  ctx: OutboundContext,
  params: {
    servicePreview?: WhatsAppServiceMessagePreview | null;
    usedFlowToken?: string;
    platformMessageId?: string;
    sentAt: Date;
  }
) {
  const canonicalFlowCommand =
    params.servicePreview?.command.kind === "flow"
      ? params.servicePreview.command
      : null;
  const flow = !ctx.whatsappServiceMessage ? ctx.whatsappFlowCta : undefined;
  const flowId = resolveSendableWhatsAppFlowProviderId({
    flowConfig: canonicalFlowCommand?.flowConfig,
    legacyFlowId: flow?.flowId,
  });
  if (ctx.type !== "whatsapp" || !flowId) return;
  await trackScenarioFlowSent({
    workspaceId: ctx.workspaceId,
    sourceId: resolveOutboundSourceId(ctx) || null,
    conversationId: String(ctx.conversation._id),
    customerWaId: getWhatsAppLogIdentity(ctx.whatsAppInfo?.contactData) || null,
    evaluationId: flow?.evaluationId || null,
    scenarioId: flow?.scenarioId || ctx.scenarioOrigin?.scenarioId || null,
    scenarioName: flow?.scenarioName || null,
    actionNodeId:
      flow?.actionNodeId || ctx.scenarioOrigin?.actionNodeId || null,
    flowId,
    flowToken:
      params.usedFlowToken ||
      canonicalFlowCommand?.flowToken ||
      flow?.flowToken ||
      null,
    outboundMessageId: params.platformMessageId || null,
    eventAt: params.sentAt,
  });
}

async function sendAndPersistOutboundDefault(ctx: OutboundContext) {
  const normalizedScenarioAttachments = normalizeScenarioActionAttachments({
    attachments: ctx.scenarioAttachments,
    legacyUrls: ctx.scenarioImageUrls,
    limit: MAX_SCENARIO_REPLY_IMAGES,
  });
  let whatsappPrimaryAttachment: ScenarioActionAttachment | undefined =
    ctx.type === "whatsapp" ? normalizedScenarioAttachments[0] : undefined;
  let airiBotUser: Awaited<ReturnType<typeof resolveAiriBotUser>> | null = null;
  const getAiriBotUser = async () => {
    if (!airiBotUser) {
      airiBotUser = await resolveAiriBotUser();
    }
    return airiBotUser;
  };

  if (ctx.temporalDeliveryKey) {
    const existing = await findExistingTemporalOutbound(ctx);
    if (existing) {
      if (
        ctx.type === "whatsapp" ||
        normalizedScenarioAttachments.length === 0
      ) {
        return existing;
      }

      const botUser = await getAiriBotUser();
      const attachmentOutbound = await sendScenarioAttachments(ctx, {
        attachments: normalizedScenarioAttachments,
        botUserId: botUser._id,
        rootOutboundPlatformMessageId: asNonEmptyString(existing.messageId),
      });
      return attachmentOutbound || existing;
    }
  }

  let generatedVoiceNote = false;
  let generatedVoicePreview: WhatsAppServiceMessagePreview | null = null;
  if (canPrepareWhatsAppVoiceReply(ctx)) {
    const window = await checkMessagingWindowForConversation(ctx.conversation);
    if (window.isWithinWindow) {
      const voiceReply = await prepareWhatsAppVoiceReplyAttachment(ctx);
      if (voiceReply) {
        whatsappPrimaryAttachment = voiceReply.attachment;
        generatedVoiceNote = true;
        generatedVoicePreview = voiceReply.preview;
      }
    }
  }

  const textToSend = String(ctx.content || "").trim();
  const whatsappServiceMessage =
    ctx.type === "whatsapp" ? ctx.whatsappServiceMessage : undefined;
  const hasWhatsAppServiceSend = Boolean(whatsappServiceMessage);
  const whatsappTemplate = hasWhatsAppServiceSend
    ? undefined
    : ctx.whatsappTemplate;
  const whatsappTemplateName = whatsappTemplate?.name?.trim() || "";
  const hasWhatsAppTemplateSend =
    ctx.type === "whatsapp" && whatsappTemplateName.length > 0;
  const hasWhatsAppPrimaryAttachment = Boolean(whatsappPrimaryAttachment);
  const hasInstagramStandaloneSend =
    ctx.type === "instagram" &&
    hasInstagramStandalonePayload(ctx.instagramMessage);
  const normalizedGroundedReplyOptions = hasWhatsAppServiceSend
    ? []
    : normalizeGroundedReplyOptions(ctx.groundedReplyOptions);
  let whatsappPrimaryMedia: WhatsAppScenarioPrimaryMedia | undefined;
  let groundedReplyOptionsPreview: StoredGroundedReplyOptionsPreview | null =
    null;

  let outbound: InstanceType<typeof Message> | null = null;
  let rootOutboundPlatformMessageId: string | undefined;
  let usedWhatsAppFlowToken: string | undefined;
  let whatsappTemplatePreview: ReturnType<
    typeof buildStoredWhatsAppTemplatePreview
  > | null = null;
  let whatsappServiceMessagePreview: WhatsAppServiceMessagePreview | null =
    generatedVoicePreview;
  groundedReplyOptionsPreview =
    normalizedGroundedReplyOptions.length > 0
      ? buildStoredGroundedReplyOptionsPreview({
          channel: ctx.type,
          options: normalizedGroundedReplyOptions,
        })
      : null;
  if (
    textToSend ||
    hasWhatsAppTemplateSend ||
    hasWhatsAppServiceSend ||
    hasWhatsAppPrimaryAttachment ||
    hasInstagramStandaloneSend
  ) {
    const deliveryStartedAt = Date.now();
    let platformMessageId: string | undefined;
    let sentAt = new Date();
    let textToPersist = textToSend;
    let telegramReplyMarkupPreview: StoredTelegramReplyMarkupPreview | null =
      null;
    let instagramStandalonePreview:
      | ReturnType<typeof resolveInstagramStandalonePreview>
      | undefined;
    let emailPersistencePayload:
      | {
          providerMessageId: string;
          subject?: string;
          headers?: Record<string, string>;
        }
      | undefined;

    // 1. Dispatch text to specific channel
    switch (ctx.type) {
      case "telegram": {
        const tg = await handleTelegramSend(ctx, textToSend);
        platformMessageId = tg.id;
        if (tg.date) sentAt = tg.date;
        telegramReplyMarkupPreview = toStoredTelegramReplyMarkupPreview(
          tg.replyMarkup
        );
        break;
      }
      case "whatsapp":
        {
          if (hasWhatsAppTemplateSend && whatsappTemplate) {
            const waTemplateResult = await handleWhatsAppTemplateSend(
              ctx,
              whatsappTemplate
            );
            platformMessageId = waTemplateResult.id;
            whatsappTemplatePreview = waTemplateResult.templatePreview || null;
          } else if (whatsappServiceMessage) {
            const serviceResult = await handleWhatsAppServiceMessageSend(
              ctx,
              whatsappServiceMessage,
              formatReplyMarkdownForWhatsApp(textToSend)
            );
            platformMessageId = serviceResult.id;
            usedWhatsAppFlowToken = serviceResult.flowTokenUsed;
            whatsappPrimaryMedia = serviceResult.primaryMedia;
            whatsappServiceMessagePreview = serviceResult.preview;
          } else {
            const waResult = await handleWhatsAppSend(
              ctx,
              textToSend,
              whatsappPrimaryAttachment,
              normalizedGroundedReplyOptions,
              ctx.whatsappServiceAppointmentChoices,
              generatedVoiceNote
            );
            platformMessageId = waResult.id;
            usedWhatsAppFlowToken = waResult.flowTokenUsed;
            whatsappPrimaryMedia = waResult.primaryMedia;
            if (waResult.textSent) {
              textToPersist = waResult.textSent;
            }
          }
        }
        break;
      case "instagram":
        platformMessageId = await handleInstagramSend(ctx, textToSend);
        if (!textToSend && hasInstagramStandaloneSend) {
          instagramStandalonePreview = resolveInstagramStandalonePreview(
            ctx.instagramMessage
          );
          textToPersist = instagramStandalonePreview.text;
        }
        break;
      case "email": {
        const emailResult = await handleEmailSend(ctx, textToSend);
        emailPersistencePayload = {
          providerMessageId: emailResult.id,
          subject: emailResult.subject,
          headers: emailResult.headers,
        };
        break;
      }
      case "web_widget":
        // Web widget relies purely on Realtime
        break;
      default:
        throw new Error(`Unsupported channel: ${ctx.type}`);
    }

    const transportCompletedAt = Date.now();
    airiReplyLogger.info("airi.reply.delivery_timing", {
      workspaceId: ctx.workspaceId,
      conversationId: String(ctx.conversation._id),
      channel: ctx.type,
      stage: "transport",
      transportMs: transportCompletedAt - deliveryStartedAt,
      hasPlatformMessageId: Boolean(platformMessageId),
      hasWhatsAppTemplateSend,
      hasWhatsAppServiceSend,
      hasWhatsAppPrimaryAttachment,
    });

    const botUser = await getAiriBotUser();
    outbound = await persistOutboundRecord(ctx, {
      messageId: platformMessageId,
      text:
        textToPersist ||
        (hasWhatsAppTemplateSend
          ? `[Template: ${whatsappTemplateName}]`
          : "[outbound]"),
      date: sentAt,
      authorId: botUser._id,
      whatsappFlow: buildStoredOutboundWhatsAppFlow(
        ctx,
        textToSend,
        usedWhatsAppFlowToken
      ),
      whatsappTemplate:
        ctx.type === "whatsapp" && hasWhatsAppTemplateSend
          ? whatsappTemplatePreview ||
            buildStoredWhatsAppTemplatePreview({
              name: whatsappTemplateName,
              languageCode: whatsappTemplate?.languageCode,
            })
          : null,
      whatsappServiceMessage:
        ctx.type === "whatsapp" &&
        (hasWhatsAppServiceSend || generatedVoiceNote)
          ? whatsappServiceMessagePreview
          : null,
      whatsappCtaLink:
        ctx.type === "whatsapp" &&
        !hasWhatsAppServiceSend &&
        ctx.whatsappCtaLink
          ? {
              title: ctx.whatsappCtaLink.title || null,
              url: ctx.whatsappCtaLink.url || null,
            }
          : null,
      telegramReplyMarkup: telegramReplyMarkupPreview,
      email: emailPersistencePayload,
      groundedReplyOptions: groundedReplyOptionsPreview,
      imageUrl:
        whatsappPrimaryMedia?.url || instagramStandalonePreview?.imageUrl,
      mediaType:
        whatsappPrimaryMedia?.mediaType ||
        instagramStandalonePreview?.mediaType,
    });
    const persistCompletedAt = Date.now();
    airiReplyLogger.info("airi.reply.delivery_timing", {
      workspaceId: ctx.workspaceId,
      conversationId: String(ctx.conversation._id),
      channel: ctx.type,
      stage: "persist",
      transportMs: transportCompletedAt - deliveryStartedAt,
      persistMs: persistCompletedAt - transportCompletedAt,
      totalMs: persistCompletedAt - deliveryStartedAt,
      hasPlatformMessageId: Boolean(platformMessageId),
      outboundMessageId: String(outbound._id),
    });
    rootOutboundPlatformMessageId =
      rootOutboundPlatformMessageId ||
      emailPersistencePayload?.providerMessageId ||
      platformMessageId;

    await trackOutboundWhatsAppFlow(ctx, {
      servicePreview: whatsappServiceMessagePreview,
      usedFlowToken: usedWhatsAppFlowToken,
      platformMessageId,
      sentAt,
    });

    if (isGreetingMessage(textToSend)) {
      await markGreetingSentToday(String(ctx.conversation._id)).catch(() => {});
    }

    // Temporal deliver path: feedback is a post-delivery effect (queued at
    // prepare) so activity retries after Meta persist still send the prompt.
    // Non-Temporal / direct send: keep inline behavior.
    if (!ctx.temporalDeliveryKey) {
      const feedbackGate = evaluateWhatsAppLlmFeedbackPrompt(ctx);
      if (!feedbackGate.allowed) {
        // Avoid noisy logs for the common "enabled but not a tester" path.
        const shouldLogSkip =
          ctx.type === "whatsapp" &&
          Boolean(platformMessageId) &&
          feedbackGate.reason !== "not_tester" &&
          feedbackGate.reason !== "prompt_disabled" &&
          feedbackGate.reason !== "not_whatsapp";
        if (shouldLogSkip) {
          airiReplyLogger.info("airi.reply.delivery", {
            conversationId: String(ctx.conversation._id),
            note: "whatsapp_llm_feedback_skipped",
            reason: feedbackGate.reason,
            recipientDigits: feedbackGate.recipientDigits || null,
            hasPlatformMessageId: Boolean(platformMessageId),
            temporalDelivery: false,
          });
        }
      } else if (!platformMessageId) {
        airiReplyLogger.warn("airi.reply.delivery", {
          conversationId: String(ctx.conversation._id),
          note: "whatsapp_llm_feedback_skipped",
          reason: "missing_platform_message_id",
          recipientDigits: feedbackGate.recipientDigits || null,
          temporalDelivery: false,
        });
      } else {
        const feedbackRecipient = resolveWhatsAppRecipientTarget(
          resolveOutboundWhatsAppContact(ctx)
        );
        if (!feedbackRecipient) {
          airiReplyLogger.warn("airi.reply.delivery", {
            conversationId: String(ctx.conversation._id),
            note: "whatsapp_llm_feedback_skipped",
            reason: "missing_feedback_recipient",
            recipientDigits: feedbackGate.recipientDigits || null,
          });
        } else {
          const queuePrompt = () =>
            enqueueWhatsAppLlmHelpfulnessPromptWithOutbox({
              workspaceId: ctx.workspaceId,
              conversationId: String(ctx.conversation._id),
              sourceId: resolveOutboundSourceId(ctx) || null,
              recipient: feedbackRecipient,
              sourceMessageId: platformMessageId,
            });

          const tryQueuePrompt = async () => {
            try {
              await queuePrompt();
              return true;
            } catch (error) {
              airiReplyLogger.warn("airi.reply.delivery", {
                conversationId: String(ctx.conversation._id),
                note: "whatsapp_llm_feedback_queue_failed",
                errorMessage:
                  error instanceof Error ? error.message : String(error),
              });
              return false;
            }
          };

          let promptQueued = await tryQueuePrompt();

          await upsertWhatsAppLlmAnswerReviewItem({
            workspaceId: ctx.workspaceId,
            conversationId: String(ctx.conversation._id),
            sourceMessageId: platformMessageId,
            outputText: textToPersist,
          }).catch(error => {
            airiReplyLogger.warn("airi.reply.delivery", {
              conversationId: String(ctx.conversation._id),
              note: "whatsapp_llm_answer_review_item_failed",
              errorMessage:
                error instanceof Error ? error.message : String(error),
            });
            return null;
          });

          if (!promptQueued) {
            promptQueued = await tryQueuePrompt();
          }

          if (promptQueued) {
            airiReplyLogger.info("airi.reply.delivery", {
              conversationId: String(ctx.conversation._id),
              note: "whatsapp_llm_feedback_queued",
              reason: feedbackGate.reason,
              recipientDigits: feedbackGate.recipientDigits || null,
              sourceMessageId: platformMessageId,
              temporalDelivery: false,
            });
          }
        }
      }
    }
  }

  // WhatsApp sends its first attachment with the text and nothing else.
  if (ctx.type !== "whatsapp" && normalizedScenarioAttachments.length > 0) {
    const botUser = await getAiriBotUser();
    outbound =
      (await sendScenarioAttachments(ctx, {
        attachments: normalizedScenarioAttachments,
        botUserId: botUser._id,
        rootOutboundPlatformMessageId,
      })) || outbound;
  }

  if (!outbound) {
    throw new Error("No outbound content was sent");
  }

  return outbound;
}

function tryCaptureTemporalOutbound(ctx: OutboundContext) {
  try {
    const temporalDispatchPolicy = ctx.temporalDispatchPolicy;
    const temporalDispatchIdentity = ctx.temporalDispatchIdentity;
    const capturedContext = { ...ctx };
    delete capturedContext.temporalDispatchPolicy;
    delete capturedContext.temporalDispatchIdentity;
    delete capturedContext.temporalDispatchOwner;
    // The capture is kept in Temporal history and Mongo; delivery re-reads the
    // Telegram bot token from its source.
    delete capturedContext.botToken;
    const capture = reserveTemporalOutboundDispatch({
      context: capturedContext as unknown as Record<string, unknown>,
      dispatchPolicy: temporalDispatchPolicy,
      dispatchIdentity: temporalDispatchIdentity,
    });

    return {
      _id: capture.placeholderMessageId,
      date: capture.placeholderDate,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Temporal outbound capture is not active")
    ) {
      return null;
    }

    throw error;
  }
}

async function findExistingTemporalOutbound(ctx: OutboundContext) {
  if (!ctx.temporalDeliveryKey && !ctx.temporalReservedMessageId) {
    return null;
  }

  const query =
    ctx.temporalDeliveryKey && ctx.temporalReservedMessageId
      ? {
          direction: "outbound",
          $or: [
            buildTemporalDeliveryKeyFilter(ctx.temporalDeliveryKey),
            { _id: ctx.temporalReservedMessageId },
          ],
        }
      : ctx.temporalDeliveryKey
        ? {
            direction: "outbound",
            ...buildTemporalDeliveryKeyFilter(ctx.temporalDeliveryKey),
          }
        : {
            direction: "outbound",
            _id: ctx.temporalReservedMessageId,
          };

  const outbound = await Message.findOne({
    conversation: ctx.conversation._id,
    ...query,
  }).sort({ createdAt: -1 });

  return outbound;
}

async function findExistingTemporalAttachment(
  ctx: OutboundContext,
  temporalDeliveryKey?: string
) {
  if (!temporalDeliveryKey) {
    return null;
  }

  return Message.findOne({
    conversation: ctx.conversation._id,
    direction: "outbound",
    ...buildTemporalDeliveryKeyFilter(temporalDeliveryKey),
  }).sort({ createdAt: -1 });
}

function buildScenarioAttachmentDeliveryKey(params: {
  baseDeliveryKey?: string;
  assetUrl: string;
  index: number;
}): string | undefined {
  if (!params.baseDeliveryKey) {
    return undefined;
  }

  const digest = createHash("sha256")
    .update(`${params.index}:${params.assetUrl}`)
    .digest("hex")
    .slice(0, 16);
  return `${params.baseDeliveryKey}:asset:${params.index}:${digest}`;
}

async function sendScenarioAttachments(
  ctx: OutboundContext,
  params: {
    attachments: ScenarioActionAttachment[];
    botUserId: unknown;
    rootOutboundPlatformMessageId?: string;
  }
): Promise<InstanceType<typeof Message> | null> {
  let outbound: InstanceType<typeof Message> | null = null;
  let rootOutboundPlatformMessageId = params.rootOutboundPlatformMessageId;

  for (const [index, attachment] of params.attachments.entries()) {
    const assetUrl = attachment.url;
    const temporalDeliveryKey = buildScenarioAttachmentDeliveryKey({
      baseDeliveryKey: ctx.temporalDeliveryKey,
      assetUrl,
      index,
    });
    const existingAttachment = await findExistingTemporalAttachment(
      ctx,
      temporalDeliveryKey
    );
    if (existingAttachment) {
      outbound = existingAttachment;
      continue;
    }

    const mediaType = toScenarioAttachmentSendType(attachment.mediaType);
    const mediaResult =
      ctx.type === "telegram"
        ? await handleTelegramMediaSend(
            ctx,
            assetUrl,
            mediaType,
            rootOutboundPlatformMessageId
          )
        : ctx.type === "instagram"
          ? await handleInstagramMediaSend(ctx, assetUrl, mediaType)
          : ctx.type === "web_widget"
            ? { id: undefined, date: new Date() }
            : null;
    if (!mediaResult) continue;
    if (!rootOutboundPlatformMessageId && mediaResult.id) {
      rootOutboundPlatformMessageId = mediaResult.id;
    }

    outbound = await persistOutboundRecord(ctx, {
      messageId: mediaResult.id,
      text: "[attachment]",
      date: mediaResult.date || new Date(),
      imageUrl: assetUrl,
      mediaType,
      authorId: params.botUserId,
      temporalDeliveryKey,
      useTemporalReservedMessageId: false,
    });
  }

  return outbound;
}

async function persistOutboundRecord(
  ctx: OutboundContext,
  payload: {
    messageId?: string;
    text: string;
    date: Date;
    imageUrl?: string;
    mediaType?: StoredMessageMediaType;
    authorId: unknown;
    whatsappFlow?: ReturnType<typeof buildStoredOutboundWhatsAppFlow>;
    whatsappTemplate?: ReturnType<
      typeof buildStoredWhatsAppTemplatePreview
    > | null;
    whatsappServiceMessage?: WhatsAppServiceMessagePreview | null;
    whatsappCtaLink?: {
      title?: string | null;
      url?: string | null;
    } | null;
    groundedReplyOptions?: StoredGroundedReplyOptionsPreview | null;
    telegramReplyMarkup?: StoredTelegramReplyMarkupPreview | null;
    email?: {
      providerMessageId: string;
      subject?: string;
      headers?: Record<string, string>;
    };
    temporalDeliveryKey?: string | null;
    useTemporalReservedMessageId?: boolean;
  }
) {
  const messageChatRef = ctx.chatDocument?._id || ctx.chatId;
  const originScenarioId =
    ctx.scenarioOrigin?.scenarioId || ctx.whatsappFlowCta?.scenarioId || null;
  const originNodeId =
    ctx.scenarioOrigin?.actionNodeId ||
    ctx.whatsappFlowCta?.actionNodeId ||
    null;
  const temporalDeliveryKey =
    payload.temporalDeliveryKey === undefined
      ? ctx.temporalDeliveryKey
      : payload.temporalDeliveryKey;
  const outboundPayload = {
    ...(payload.useTemporalReservedMessageId !== false &&
    ctx.temporalReservedMessageId &&
    !ctx.temporalDispatchOwner
      ? { _id: ctx.temporalReservedMessageId }
      : {}),
    messageId: payload.messageId,
    chat: messageChatRef,
    author: payload.authorId ?? 0,
    text: payload.text,
    ...(payload.email?.subject ? { subject: payload.email.subject } : {}),
    ...(payload.email?.headers ? { headers: payload.email.headers } : {}),
    ...(payload.email?.providerMessageId
      ? { external_ids: { messageId: payload.email.providerMessageId } }
      : {}),
    imageUrl: payload.imageUrl,
    mediaType: payload.mediaType,
    date: payload.date,
    workspaceId: ctx.workspaceId,
    conversation: ctx.conversation._id,
    channel: ctx.type,
    direction: "outbound",
    origin: {
      kind: originScenarioId ? "scenario" : "airi",
      scenarioId: originScenarioId,
      nodeId: originNodeId,
      templateName: payload.whatsappTemplate?.name || null,
      sourceId: ctx.conversation.sourceId || null,
    },
    ...(temporalDeliveryKey ? { temporalDeliveryKey } : {}),
    ...(payload.whatsappFlow ? { whatsappFlow: payload.whatsappFlow } : {}),
    ...(payload.whatsappTemplate
      ? { whatsappTemplate: payload.whatsappTemplate }
      : {}),
    ...(payload.whatsappServiceMessage
      ? { whatsappServiceMessage: payload.whatsappServiceMessage }
      : {}),
    ...(payload.whatsappCtaLink
      ? { whatsappCtaLink: payload.whatsappCtaLink }
      : {}),
    ...(payload.groundedReplyOptions
      ? { groundedReplyOptions: payload.groundedReplyOptions }
      : {}),
    ...(payload.telegramReplyMarkup
      ? { telegramReplyMarkup: payload.telegramReplyMarkup }
      : {}),
  };
  const outbound = ctx.temporalDispatchOwner
    ? ctx.temporalDispatchOwner.set(outboundPayload)
    : new Message(outboundPayload);

  if (ctx.temporalDispatchOwner) {
    const dispatchOwner = outbound as TemporalDispatchMessage;
    dispatchOwner.temporalDispatch = buildTemporalDispatchSnapshot({
      owner: dispatchOwner,
      state: "sent",
      now: new Date(),
    });
    dispatchOwner.$locals ||= {};
    dispatchOwner.$locals.wasTemporalDispatchFinalized = true;
  }

  await outbound.save();

  await appendMessageToConversationById(ctx.conversation._id, outbound._id, {
    lastMessageAt: outbound.date,
    direction: "outbound",
  });

  await notifyClients(ctx, outbound);

  return outbound;
}

function resolveTelegramBusinessConnectionId(
  ctx: Pick<OutboundContext, "chatDocument" | "conversation">
): string | undefined {
  return resolveBusinessConnectionId(
    ctx.conversation?.business_connection_id,
    ctx.chatDocument?.businessConnectionId
  );
}

async function resolveTelegramSendOptions(ctx: OutboundContext) {
  if (!ctx.chatId) throw new Error("Missing Telegram chatId");

  const realChatId = parseTelegramCompositeChatId(String(ctx.chatId));
  const isGroup = ctx.chatType === "group" || ctx.chatType === "supergroup";
  const bizId = isGroup ? undefined : resolveTelegramBusinessConnectionId(ctx);
  const botToken = await resolveTelegramBotToken(ctx);
  return {
    realChatId,
    options: {
      ...(bizId ? { businessConnectionId: bizId } : {}),
      ...(botToken ? { botToken } : {}),
    },
  };
}

/**
 * Builds a Telegram InlineKeyboardMarkup from scenario quick-reply buttons
 * and optional link URLs.
 *
 * Quick-reply buttons encode `sqr:<conversationId>:<payload>` as callback_data
 * so the callback-query handler can deterministically route to a matching
 * sub-scenario. Telegram limits `callback_data` to 1-64 bytes (UTF-8).
 *
 * Link URLs are rendered as native Telegram URL buttons (using the `url` field
 * instead of `callback_data`), so they open directly in the user's browser.
 */
function buildTelegramInlineKeyboard(
  buttons: OutboundContext["telegramQuickReplies"],
  conversationId: string,
  linkUrls?: string[],
  linkButtonLabel?: string,
  callbackPrefix: "sqr" | "gqr" = "sqr"
): TelegramInlineKeyboard | undefined {
  const inline_keyboard: TelegramInlineButton[][] = [];
  const trimmedLinkLabel = linkButtonLabel?.trim() || "";

  const rows = coerceTelegramQuickRepliesToRows(buttons ?? []);
  if (rows.length > 0) {
    const MAX_CALLBACK_BYTES = TELEGRAM_CALLBACK_DATA_MAX_UTF8_BYTES;
    const prefix = `${callbackPrefix}:${conversationId}:`;
    const prefixBytes = Buffer.byteLength(prefix, "utf8");
    const budgetForPayload = MAX_CALLBACK_BYTES - prefixBytes;

    for (const row of rows) {
      const rowButtons: TelegramInlineButton[] = [];
      for (const b of row) {
        if (!b.text || !b.payload) continue;
        const safePayload = truncateUtf8(b.payload, budgetForPayload);
        if (!safePayload || safePayload !== b.payload) {
          continue;
        }
        rowButtons.push({
          text: b.text.slice(0, TELEGRAM_INLINE_BUTTON_TEXT_MAX_CHARS),
          callback_data: `${prefix}${safePayload}`,
        });
      }
      if (rowButtons.length > 0) {
        inline_keyboard.push(rowButtons);
      }
    }
  }

  // Add link URL buttons
  if (Array.isArray(linkUrls)) {
    for (const raw of linkUrls) {
      if (typeof raw !== "string") continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          const fallbackHostLabel = parsed.hostname.replace(/^www\./, "");
          const displayLabel = trimmedLinkLabel
            ? trimmedLinkLabel.slice(0, TELEGRAM_INLINE_BUTTON_TEXT_MAX_CHARS)
            : fallbackHostLabel.slice(0, TELEGRAM_INLINE_BUTTON_TEXT_MAX_CHARS);
          inline_keyboard.push([
            { text: displayLabel, url: parsed.toString() },
          ]);
        }
      } catch {
        // Skip invalid URLs
      }
    }
  }

  return inline_keyboard.length > 0 ? { inline_keyboard } : undefined;
}

type StoredTelegramReplyMarkupPreview = {
  inlineKeyboard: Array<
    Array<{ text: string; type: "callback" | "url"; url: string | null }>
  >;
};

/** What the inbox shows for the inline keyboard that was actually sent. */
function toStoredTelegramReplyMarkupPreview(
  keyboard: TelegramInlineKeyboard | undefined
): StoredTelegramReplyMarkupPreview | null {
  if (!keyboard) return null;
  return {
    inlineKeyboard: keyboard.inline_keyboard.map(row =>
      row.map(button =>
        button.url
          ? { text: button.text, type: "url" as const, url: button.url }
          : { text: button.text, type: "callback" as const, url: null }
      )
    ),
  };
}

async function handleEmailSend(
  ctx: OutboundContext,
  text: string
): Promise<{
  id: string;
  subject?: string;
  headers?: Record<string, string>;
}> {
  const to = ctx.conversation.participants?.from?.[0]?.trim();
  const fromAddress = ctx.conversation.participants?.to?.[0]?.trim();

  if (!to || !fromAddress) {
    throw new Error("Email participants missing");
  }

  const provider = await resolveActiveEmailProvider(ctx.workspaceId);
  if (!provider.ok) throw new Error(provider.error);
  const { providerConfig } = provider;

  // Airi replies to the conversation's latest message.
  const messageIds = Array.isArray(ctx.conversation.messages)
    ? ctx.conversation.messages
    : [];
  const headers = await buildEmailReplyHeaders(
    messageIds.length ? String(messageIds[messageIds.length - 1]) : undefined
  );
  const subject = ctx.conversation.subject || undefined;
  const { MessageID } = await postmarkSendEmail({
    from: fromAddress,
    to: [to],
    subject,
    text,
    headers,
    messageStream: providerConfig.transactionalStream,
    serverToken: providerConfig.postmarkServerToken,
  });

  return {
    id: MessageID,
    subject,
    headers,
  };
}

async function handleTelegramSend(ctx: OutboundContext, text: string) {
  const { realChatId, options } = await resolveTelegramSendOptions(ctx);
  // Always convert to HTML so Telegram renders formatting correctly instead
  // of showing raw markdown symbols to users.
  const telegramText = formatReplyMarkdownForTelegramHtml(text);
  const groundedReplyOptions = normalizeGroundedReplyOptions(
    ctx.groundedReplyOptions
  );
  const telegramQuickReplies =
    groundedReplyOptions.length > 0
      ? groundedReplyOptions.map(option => ({
          text: option.label,
          payload: option.callbackKey || option.id,
        }))
      : ctx.telegramQuickReplies;
  const replyMarkup = buildTelegramInlineKeyboard(
    telegramQuickReplies,
    String(ctx.conversation._id),
    ctx.telegramLinkUrls,
    ctx.telegramLinkButtonLabel,
    groundedReplyOptions.length > 0 ? "gqr" : "sqr"
  );
  const result = await telegramApi.sendTelegramMessage(
    realChatId,
    telegramText,
    {
      ...options,
      parseMode: "HTML",
      ...(replyMarkup ? { replyMarkup } : {}),
    }
  );

  return {
    id: result.messageId?.toString(),
    date: result.date ? new Date(result.date * 1000) : undefined,
    replyMarkup,
  };
}

async function handleTelegramMediaSend(
  ctx: OutboundContext,
  mediaUrl: string,
  mediaType: "image" | "video" | "document",
  replyToPlatformMessageId?: string
) {
  const { realChatId, options } = await resolveTelegramSendOptions(ctx);
  const parsedReplyToMessageId = Number.parseInt(
    String(replyToPlatformMessageId || ""),
    10
  );

  // Telegram clears a bot's chat action on the next bot message, but uploads
  // can take seconds. Firing the matching action gives the user an "uploading
  // photo/video/document…" status instead of a silent pause.
  // Fire-and-forget: a failed chat action must never block the real send.
  const chatActionByMedia = {
    image: "upload_photo",
    video: "upload_video",
    document: "upload_document",
  } as const;
  void telegramApi
    .sendChatAction(realChatId, chatActionByMedia[mediaType], options)
    .catch(() => {});

  const result = await telegramApi.sendTelegramMedia(
    realChatId,
    { type: mediaType, url: mediaUrl },
    Number.isFinite(parsedReplyToMessageId) && parsedReplyToMessageId > 0
      ? { ...options, replyToMessageId: parsedReplyToMessageId }
      : options
  );

  return {
    id: result.messageId?.toString(),
    date: result.date ? new Date(result.date * 1000) : undefined,
  };
}

async function handleWhatsAppTemplateSend(
  ctx: OutboundContext,
  template: NonNullable<OutboundContext["whatsappTemplate"]>,
  beforeSend?: () => Promise<void>
): Promise<{
  id?: string;
  templatePreview?: ReturnType<
    typeof buildStoredWhatsAppTemplatePreview
  > | null;
}> {
  const { whatsAppInfo, recipientTarget } = await requireWhatsAppTransport(
    ctx,
    Boolean(beforeSend || ctx.whatsappFlowCta?.managedSourceId)
  );
  assertWhatsAppFlowOutboundSource({
    ctx,
    managedSourceId: ctx.whatsappFlowCta?.managedSourceId,
    managedWabaId: ctx.whatsappFlowCta?.managedWabaId,
    outboundWabaId: whatsAppInfo.wabaId,
  });

  const templateName = template.name.trim();
  if (!templateName) return {};
  const { WhatsAppTemplateModel } = await import("@/models/whatsapp-template");
  const templateMeta = await WhatsAppTemplateModel.findOne({
    workspaceId: ctx.workspaceId,
    name: templateName,
  })
    .select("category components")
    .lean<{ category?: string; components?: unknown } | null>()
    .catch(() => null);

  const { refreshWhatsAppTemplateMediaForSend } = await import(
    "@/lib/whatsapp/templates/send-lookup"
  );
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { isWhatsAppTemplateMediaDownloadError } = await import(
    "@/lib/whatsapp/media-upload"
  );
  const languageCode = (template.languageCode || "en").trim() || "en";
  const mediaRefresh = {
    workspaceId: ctx.workspaceId,
    sourceId: ctx.behaviorRun?.sourceId || resolveOutboundSourceId(ctx),
    expectedWabaId: whatsAppInfo.wabaId,
    templateName,
    languageCode,
    components: template.components,
    useTemplateMedia: template.headerMediaSource === "template",
    requireMatchingSample: Boolean(ctx.scenarioOrigin),
    supabase: supabaseAdmin,
  };
  const components = await refreshWhatsAppTemplateMediaForSend(mediaRefresh);
  let messagePostStarted = false;
  const send = (sendComponents: typeof components) =>
    whatsappApi.sendWhatsappTemplate(
      whatsAppInfo.phoneNumberId,
      whatsAppInfo.accessToken,
      recipientTarget,
      templateName,
      languageCode,
      sendComponents,
      {
        beforeSend: async () => {
          await beforeSend?.();
          messagePostStarted = true;
        },
        requirePhoneRecipient: templateMeta?.category === "AUTHENTICATION",
        messagingAccountId:
          typeof whatsAppInfo.messagingAccountId === "string"
            ? whatsAppInfo.messagingAccountId
            : undefined,
      }
    );
  let result: Awaited<ReturnType<typeof send>>;
  try {
    result = await send(components);
  } catch (error) {
    if (
      messagePostStarted ||
      !isWhatsAppTemplateMediaDownloadError(error) ||
      (error.status !== 403 && error.status !== 404)
    )
      throw error;
    // A media GET failed before any message POST. The catalog can contain a
    // cached expiring sample URL; one forced refresh stays within this owner.
    const refreshed = await refreshWhatsAppTemplateMediaForSend({
      ...mediaRefresh,
      force: true,
    });
    result = await send(refreshed);
  }

  const id = result.messageId?.toString();
  return {
    id: id ? normalizeWhatsAppMessageId(id) : undefined,
    templatePreview: buildStoredWhatsAppTemplatePreview({
      name: templateName,
      languageCode: template.languageCode,
      components: templateMeta?.components,
    }),
  };
}

type WhatsAppScenarioPrimaryMedia = {
  url: string;
  mediaType: ScenarioActionAttachment["mediaType"];
};

function buildWhatsAppInteractiveHeaderMedia(
  attachment?: ScenarioActionAttachment
): whatsappApi.WhatsAppInteractiveHeaderMedia | undefined {
  if (!attachment?.url) return undefined;
  if (
    attachment.mediaType !== "image" &&
    attachment.mediaType !== "video" &&
    attachment.mediaType !== "document"
  ) {
    return undefined;
  }
  return {
    type: attachment.mediaType,
    link: attachment.url,
    fileName: attachment.fileName,
  };
}

function formatWhatsAppServiceCompileFailure(
  diagnostics: Array<{ code: string; path?: string }>
) {
  return diagnostics
    .map(diagnostic =>
      diagnostic.path
        ? `${diagnostic.code} (${diagnostic.path})`
        : diagnostic.code
    )
    .join(", ");
}

async function handleWhatsAppServiceMessageSend(
  ctx: OutboundContext,
  config: ScenarioWhatsAppServiceMessage,
  resolvedBodyText: string,
  beforeSend?: () => Promise<void>
): Promise<{
  id?: string;
  flowTokenUsed?: string;
  primaryMedia?: WhatsAppScenarioPrimaryMedia;
  preview: WhatsAppServiceMessagePreview;
}> {
  const message = config.message;
  const { whatsAppInfo, recipientTarget } = await requireWhatsAppTransport(
    ctx,
    Boolean(
      beforeSend ||
        (message.kind === "flow" &&
          whatsappFlowRequiresBoundSource(message.flowConfig))
    )
  );

  const window = await checkMessagingWindowForConversation(ctx.conversation);
  if (!window.isWithinWindow) {
    throw new WhatsAppServiceWindowClosedError();
  }

  const boundFlowSourceId =
    message.kind === "flow"
      ? assertWhatsAppFlowOutboundSource({
          ctx,
          flowConfig: message.flowConfig,
          outboundWabaId: whatsAppInfo.wabaId,
        })
      : undefined;
  let managedSignupLinkUrl: string | undefined;
  if (message.kind === "cta_url" && message.urlSource.kind === "signup_link") {
    const { resolveWhatsAppSignupLinkForScenario } = await import(
      "@/lib/airi/reply/runtime/whatsapp-signup-link"
    );
    const liveLink = await resolveWhatsAppSignupLinkForScenario({
      workspaceId: ctx.workspaceId,
      signupLinkId: message.urlSource.signupLinkId,
      sourceId: resolveOutboundSourceId(ctx),
    });
    if (liveLink?.status === "ACTIVE") {
      managedSignupLinkUrl = liveLink.deepLinkUrl;
    }
  }

  const needsSourceCapabilities =
    message.kind === "voice_call" || message.kind === "commerce";
  const sourceContext = needsSourceCapabilities
    ? await resolveWhatsAppSendContext({
        workspaceId: ctx.workspaceId,
        sourceId: resolveOutboundSourceId(ctx),
      })
    : null;
  const catalogId =
    message.kind === "commerce" ? message.commerce.catalogId.trim() : "";
  const flowToken =
    message.kind === "flow" && message.flowConfig
      ? buildFlowEndpointTokenFromConfig(message.flowConfig) ||
        `flow_${randomUUID()}`
      : undefined;

  const compiled = compileWhatsAppServiceMessage({
    config,
    resolvedBodyText,
    managedSignupLinkUrl,
    flowToken,
    sourceId: boundFlowSourceId,
    wabaId: whatsAppInfo.wabaId,
    appointmentChoices: ctx.whatsappServiceAppointmentChoices,
    recipientKind: recipientTarget.kind === "phone" ? "phone" : "bsuid",
    callingReady: sourceContext?.callingReady === true,
    catalogAvailable:
      message.kind !== "commerce" ||
      Boolean(catalogId && sourceContext?.catalogIds?.includes(catalogId)),
  });
  if (!compiled.ok) {
    throw new Error(
      `WhatsApp service message cannot be sent: ${formatWhatsAppServiceCompileFailure(
        compiled.diagnostics
      )}`
    );
  }

  const flowId =
    compiled.command.kind === "flow"
      ? resolveWhatsAppFlowProviderId({
          flowConfig: compiled.command.flowConfig,
        }) || ""
      : "";
  if (flowId) {
    await assertWhatsAppFlowSendAllowed(ctx, flowId);
  }

  let result: Awaited<ReturnType<typeof sendWhatsAppServiceMessage>>;
  try {
    result = await sendWhatsAppServiceMessage({
      phoneNumberId: whatsAppInfo.phoneNumberId,
      accessToken: whatsAppInfo.accessToken,
      sourceId: boundFlowSourceId,
      wabaId: whatsAppInfo.wabaId,
      recipient: recipientTarget,
      command: compiled.command,
      workspaceId: ctx.workspaceId,
      beforeSend,
    });
  } catch (error) {
    if (flowId) {
      return throwWhatsAppFlowSendFailure(ctx, flowId, error);
    }
    throw error;
  }
  const messageId = result.messageId?.toString();
  const prepared = result.preparedCommand;
  const primaryAttachment =
    prepared.kind === "media"
      ? prepared.attachment
      : prepared.kind === "media_carousel"
        ? prepared.cards[0]?.media
        : undefined;
  const flowTokenUsed =
    prepared.kind === "flow" &&
    "flowTokenUsed" in result &&
    typeof result.flowTokenUsed === "string"
      ? result.flowTokenUsed
      : undefined;

  return {
    id: messageId ? normalizeWhatsAppMessageId(messageId) : undefined,
    ...(flowTokenUsed ? { flowTokenUsed } : {}),
    ...(primaryAttachment
      ? {
          primaryMedia: {
            url: primaryAttachment.url,
            mediaType: primaryAttachment.mediaType,
          },
        }
      : {}),
    preview: compiled.preview,
  };
}

async function handleWhatsAppSend(
  ctx: OutboundContext,
  text: string,
  primaryAttachment: ScenarioActionAttachment | undefined,
  groundedReplyOptions: GroundedReplyOption[],
  appointmentChoices?: ScenarioWhatsAppSessionChoice[],
  generatedVoiceNote = false
): Promise<{
  id?: string;
  flowTokenUsed?: string;
  textSent?: string;
  primaryMedia?: WhatsAppScenarioPrimaryMedia;
}> {
  const scenarioFlowId = (ctx.whatsappFlowCta?.flowId || "").trim();
  const { whatsAppInfo, recipientTarget } = await requireWhatsAppTransport(
    ctx,
    Boolean(ctx.whatsappFlowCta?.managedSourceId)
  );
  if (scenarioFlowId) {
    assertWhatsAppFlowOutboundSource({
      ctx,
      managedSourceId: ctx.whatsappFlowCta?.managedSourceId,
      managedWabaId: ctx.whatsappFlowCta?.managedWabaId,
      outboundWabaId: whatsAppInfo.wabaId,
    });
  }

  const window = await checkMessagingWindowForConversation(ctx.conversation);
  if (!window.isWithinWindow) {
    if (scenarioFlowId) {
      throw new Error(
        `WhatsApp Flow send failed for flow "${scenarioFlowId}": messaging window is closed`
      );
    }
    return {};
  }

  const resolvedPrimaryAttachment = primaryAttachment
    ? await resolveScenarioActionAttachmentHttpsUrl({
        workspaceId: ctx.workspaceId,
        attachment: primaryAttachment,
      })
    : undefined;

  const whatsappText = formatReplyMarkdownForWhatsApp(text);
  const sessionChoices = normalizeWhatsAppSessionChoices(
    appointmentChoices,
    ctx.scenarioOrigin?.actionNodeId
  );
  const headerMedia = buildWhatsAppInteractiveHeaderMedia(
    resolvedPrimaryAttachment
  );
  const primaryMedia = resolvedPrimaryAttachment
    ? {
        url: resolvedPrimaryAttachment.url,
        mediaType: resolvedPrimaryAttachment.mediaType,
      }
    : undefined;
  const headerMediaArg = headerMedia
    ? ([headerMedia] as [whatsappApi.WhatsAppInteractiveHeaderMedia])
    : ([] as []);

  // Up to 3 options go out as reply buttons, more as a list; on failure the
  // caller falls back to plain text.
  const sendInteractiveOptions = async (
    options: Array<{ id: string; title: string; description?: string | null }>,
    fallbackNote: string
  ) => {
    const interactiveBody = stripKBLinksForWhatsApp(whatsappText).slice(
      0,
      1024
    );

    try {
      const res =
        options.length <= 3
          ? await whatsappApi.sendWhatsappInteractiveReplyButtons(
              whatsAppInfo.phoneNumberId,
              whatsAppInfo.accessToken,
              recipientTarget,
              interactiveBody || "Please choose an option.",
              options.map(option => ({ id: option.id, title: option.title })),
              ...headerMediaArg
            )
          : await whatsappApi.sendWhatsappInteractiveList(
              whatsAppInfo.phoneNumberId,
              whatsAppInfo.accessToken,
              recipientTarget,
              interactiveBody || "Please choose an option.",
              "View options",
              options.map(option => ({
                id: option.id,
                title: option.title,
                description: option.description || undefined,
              })),
              ...headerMediaArg
            );
      const id = res.messageId?.toString();
      return {
        id: id ? normalizeWhatsAppMessageId(id) : undefined,
        primaryMedia,
      };
    } catch (error) {
      airiReplyLogger.warn("airi.reply.delivery", {
        conversationId: String(ctx.conversation._id),
        note: fallbackNote,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  if (groundedReplyOptions.length > 0) {
    const sent = await sendInteractiveOptions(
      groundedReplyOptions.map(option => ({
        id: option.callbackKey || option.id,
        title: option.label,
        description: option.description,
      })),
      "whatsapp_grounded_options_fallback_to_text"
    );
    if (sent) return sent;
  }

  if (sessionChoices && sessionChoices.length > 0) {
    const sent = await sendInteractiveOptions(
      sessionChoices.map(option => ({
        id: option.payload,
        title: option.text,
        description: option.description,
      })),
      "whatsapp_session_choices_fallback_to_text"
    );
    if (sent) return sent;
  }

  if (scenarioFlowId) {
    await assertWhatsAppFlowSendAllowed(ctx, scenarioFlowId);

    const flowToken =
      (ctx.whatsappFlowCta?.flowToken || "").trim() ||
      `flow_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const flowCtaRaw = (ctx.whatsappFlowCta?.flowCta || "Open flow").trim();
    const flowCta = flowCtaRaw.slice(0, 30) || "Open flow";
    const flowBody = stripKBLinksForWhatsApp(whatsappText).slice(0, 1024);

    try {
      const res = await whatsappApi.sendWhatsappInteractiveFlow(
        whatsAppInfo.phoneNumberId,
        whatsAppInfo.accessToken,
        recipientTarget,
        {
          flowId: scenarioFlowId,
          flowToken,
          flowCta,
          bodyText: flowBody || "Please complete this flow.",
          headerText: ctx.whatsappFlowCta?.headerText,
          footerText: ctx.whatsappFlowCta?.footerText,
          flowActionType: ctx.whatsappFlowCta?.flowActionType,
          flowActionPayload: ctx.whatsappFlowCta?.flowActionPayload,
        }
      );
      const id = res.messageId?.toString();
      return {
        id: id ? normalizeWhatsAppMessageId(id) : undefined,
        flowTokenUsed: flowToken,
      };
    } catch (error) {
      return throwWhatsAppFlowSendFailure(ctx, scenarioFlowId, error);
    }
  }

  if (ctx.whatsappCtaLink) {
    const bodyWithoutLink = stripLinkForWhatsAppCta(
      whatsappText,
      ctx.whatsappCtaLink.url
    );
    const buttonLabelRaw = (ctx.whatsappCtaLink.title || "Open link").trim();
    const buttonLabel =
      buttonLabelRaw.length <= 20 ? buttonLabelRaw : "Open link";

    try {
      const res = await whatsappApi.sendWhatsappInteractiveCtaUrl(
        whatsAppInfo.phoneNumberId,
        whatsAppInfo.accessToken,
        recipientTarget,
        bodyWithoutLink,
        ctx.whatsappCtaLink.url,
        buttonLabel,
        headerMedia
      );
      const id = res.messageId?.toString();
      return {
        id: id ? normalizeWhatsAppMessageId(id) : undefined,
        primaryMedia,
      };
    } catch (error) {
      airiReplyLogger.warn("airi.reply.delivery", {
        conversationId: String(ctx.conversation._id),
        note: "whatsapp_cta_url_fallback_to_text",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const plainText = groundedReplyOptions.length
    ? appendGroundedReplyOptionsInlineText({
        reply: whatsappText,
        options: groundedReplyOptions,
      })
    : sessionChoices && sessionChoices.length > 0
      ? `${whatsappText}\n\n${sessionChoices
          .map((option, index) => `${index + 1}. ${option.text}`)
          .join("\n")}`
      : whatsappText;
  if (resolvedPrimaryAttachment) {
    const res = await whatsappApi.sendWhatsappMedia(
      whatsAppInfo.phoneNumberId,
      whatsAppInfo.accessToken,
      recipientTarget,
      {
        type: resolvedPrimaryAttachment.mediaType,
        link: resolvedPrimaryAttachment.url,
        caption: plainText || undefined,
        fileName: resolvedPrimaryAttachment.fileName,
        ...(generatedVoiceNote ? { voice: true } : {}),
      }
    );

    const id = res.messageId?.toString();
    return {
      id: id ? normalizeWhatsAppMessageId(id) : undefined,
      textSent: plainText,
      primaryMedia,
    };
  }

  if (!plainText) {
    return {};
  }

  const res = await whatsappApi.sendWhatsappMessage(
    whatsAppInfo.phoneNumberId,
    whatsAppInfo.accessToken,
    recipientTarget,
    plainText
  );

  const id = res.messageId?.toString();
  return {
    id: id ? normalizeWhatsAppMessageId(id) : undefined,
    textSent: plainText,
  };
}

function toScenarioAttachmentSendType(
  mediaType: ScenarioActionAttachment["mediaType"]
): "image" | "video" | "document" {
  return mediaType === "image" || mediaType === "video" ? mediaType : "document";
}

function stripKBLinksForWhatsApp(content: string): string {
  if (!content) return "";

  let out = stripKbArticleLinksFooter(content);

  // Remove markdown links, keep link text
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1");

  // Remove bare URLs on their own line
  out = out.replace(/\nhttps?:\/\/[^\s]+(\n|$)/g, "\n");

  return out.trim();
}

function stripLinkForWhatsAppCta(content: string, ctaUrl: string): string {
  const base = stripKBLinksForWhatsApp(content);
  if (!ctaUrl) return base || "Open the button below.";

  let out = base;

  // Remove markdown links that point to the CTA URL while preserving visible text.
  const escapedUrl = ctaUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const markdownLinkToCta = new RegExp(
    `\\[([^\\]]+)\\]\\(${escapedUrl}\\)`,
    "g"
  );
  out = out.replace(markdownLinkToCta, "$1");

  // Remove direct CTA URL references from the body.
  const bareCtaUrl = new RegExp(escapedUrl, "g");
  out = out.replace(bareCtaUrl, "");

  out = out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s{2,}/g, " ")
    .trim();

  return out || "Open the button below.";
}

type InstagramGraphMessage =
  | { text: string; quick_replies?: Array<Record<string, string>> }
  | {
      attachment: {
        type: "template" | string;
        payload: Record<string, unknown>;
      };
    };

type InstagramTemplateButton =
  | { type: "web_url"; title: string; url: string }
  | { type: "postback"; title: string; payload: string };

function toInstagramTemplateButtons(
  buttons: ScenarioInstagramButton[]
): InstagramTemplateButton[] {
  return buttons.flatMap((button): InstagramTemplateButton[] => {
    if (button.type === "web_url" && button.url) {
      return [{ type: "web_url", title: button.title, url: button.url }];
    }
    if (button.type === "postback" && button.payload) {
      return [
        { type: "postback", title: button.title, payload: button.payload },
      ];
    }
    return [];
  });
}

/**
 * Cards and media are separate Instagram messages, so a reply text that goes
 * with them is sent first as its own message, the way the builder previews it.
 */
function buildInstagramMessagePayloads(
  text: string,
  config: OutboundContext["instagramMessage"]
): InstagramGraphMessage[] {
  const formattedText = truncateUtf8(
    formatReplyMarkdownForInstagram(text),
    INSTAGRAM_TEXT_MAX_BYTES
  );
  const normalized = normalizeInstagramConfig(config);
  const leadingText: InstagramGraphMessage[] = formattedText
    ? [{ text: formattedText }]
    : [];

  if (normalized.kind === "quick_replies") {
    const quickReplies = (normalized.quickReplies ?? []).map(option => ({
      content_type: "text",
      title: option.title,
      payload: option.payload,
    }));
    return quickReplies.length > 0 && formattedText
      ? [{ text: formattedText, quick_replies: quickReplies }]
      : leadingText;
  }

  if (normalized.kind === "button_template") {
    const buttons = toInstagramTemplateButtons(normalized.buttons ?? []);
    if (buttons.length > 0 && formattedText) {
      return [
        {
          attachment: {
            type: "template",
            payload: {
              template_type: "button",
              text: formattedText.slice(
                0,
                INSTAGRAM_BUTTON_TEMPLATE_TEXT_MAX_CHARS
              ),
              buttons,
            },
          },
        },
      ];
    }
  }

  if (normalized.kind === "generic_template") {
    const elements = buildInstagramGenericTemplateElements(normalized);
    if (elements.length > 0) {
      return [
        ...leadingText,
        {
          attachment: {
            type: "template",
            payload: {
              template_type: "generic",
              elements,
            },
          },
        },
      ];
    }
  }

  if (normalized.kind === "media" && normalized.mediaUrl) {
    return [
      ...leadingText,
      {
        attachment: {
          type: normalized.mediaType || "image",
          payload: {
            url: normalized.mediaUrl,
          },
        },
      },
    ];
  }

  return leadingText;
}

function buildInstagramGenericTemplateElements(
  config: ReturnType<typeof normalizeInstagramConfig>
) {
  return (config.cards ?? []).flatMap(card => {
    const buttons = toInstagramTemplateButtons(card.buttons ?? []);
    return card.title
      ? [
          {
            title: card.title,
            ...(card.subtitle ? { subtitle: card.subtitle } : {}),
            ...(card.imageUrl ? { image_url: card.imageUrl } : {}),
            ...(buttons.length > 0 ? { buttons } : {}),
          },
        ]
      : [];
  });
}

/** Cards and media can go out without any reply text. */
function hasInstagramStandalonePayload(
  config: OutboundContext["instagramMessage"]
): boolean {
  if (!config) return false;
  const normalized = normalizeInstagramConfig(config);
  if (normalized.kind === "generic_template") {
    return buildInstagramGenericTemplateElements(normalized).length > 0;
  }
  return normalized.kind === "media" && Boolean(normalized.mediaUrl);
}

/** What the inbox shows for a cards or media reply that had no text. */
function resolveInstagramStandalonePreview(
  config: OutboundContext["instagramMessage"]
): { text: string; imageUrl?: string; mediaType?: StoredMessageMediaType } {
  const normalized = normalizeInstagramConfig(config);
  if (normalized.kind === "media" && normalized.mediaUrl) {
    return {
      text: "[attachment]",
      imageUrl: normalized.mediaUrl,
      mediaType: normalized.mediaType || "image",
    };
  }
  const titles = buildInstagramGenericTemplateElements(normalized).map(
    element => element.title
  );
  return { text: titles.join(" · ") || "[outbound]" };
}

/** Proactive sends (timers, late results) must respect the 24-hour window. */
async function assertInstagramDmWindowOpen(ctx: OutboundContext) {
  const window = await checkMessagingWindowForConversation(ctx.conversation);
  if (window.isWithinWindow) return;
  throw new InstagramSendError({
    code: window.lastCustomerMessageAt
      ? "instagram_window_closed"
      : "instagram_customer_message_required",
  });
}

async function handleInstagramSend(
  ctx: OutboundContext,
  text: string
): Promise<string | undefined> {
  if (!ctx.instagramInfo) throw new Error("Missing Instagram config");

  const senderId = ctx.instagramInfo.pageId;
  if (!senderId) throw new Error("Missing Instagram sender ID");
  const threadType =
    String(ctx.instagramInfo.threadType || "").toLowerCase() === "comment"
      ? "comment"
      : "dm";
  const authMethod = String(ctx.instagramInfo.authMethod || "");
  const graphApiBase = resolveInstagramGraphBase(authMethod);
  const commentId =
    typeof ctx.instagramInfo.commentId === "string"
      ? ctx.instagramInfo.commentId.trim()
      : "";
  if (threadType === "comment" && !commentId) {
    throw new Error("Missing Instagram comment ID");
  }
  if (threadType === "dm" && !ctx.instagramInfo.recipientId) {
    throw new Error("Missing Instagram recipient ID");
  }

  if (threadType === "comment") {
    const url = `${graphApiBase}/${encodeURIComponent(commentId)}/replies`;
    const response = await postInstagramGraph(
      url,
      ctx.instagramInfo.accessToken,
      { message: formatReplyMarkdownForInstagram(text) }
    );
    if (!response.ok) {
      await throwInstagramGraphFailure(response, url, {
        kind: "comment_reply",
      });
    }
    return readInstagramSendId(response);
  }

  await assertInstagramDmWindowOpen(ctx);

  const url = `${graphApiBase}/${encodeURIComponent(senderId)}/messages`;
  const messages = buildInstagramMessagePayloads(text, ctx.instagramMessage);
  let firstMessageId: string | undefined;
  for (const [index, message] of messages.entries()) {
    const response = await postInstagramGraph(
      url,
      ctx.instagramInfo.accessToken,
      {
        recipient: { id: ctx.instagramInfo.recipientId },
        message,
      }
    );
    if (response.ok) {
      firstMessageId ||= await readInstagramSendId(response);
      continue;
    }

    const failure = await readInstagramGraphFailure(response, url).then(error =>
      toInstagramSendError(error, {
        kind: "dm",
        isAttachment:
          "attachment" in message && message.attachment.type !== "template",
      })
    );
    // A retry would repeat the text that already reached the customer, so a
    // failed cards/media part after it is logged instead of thrown.
    if (index > 0 && firstMessageId) {
      airiReplyLogger.warn("airi.reply.delivery", {
        conversationId: String(ctx.conversation._id),
        note: "instagram_followup_part_failed",
        errorCode: failure.code,
        errorMessage: failure.message,
      });
      break;
    }
    throw failure;
  }
  return firstMessageId;
}

async function handleInstagramMediaSend(
  ctx: OutboundContext,
  mediaUrl: string,
  mediaType: "image" | "video" | "document"
): Promise<{ id?: string; date?: Date } | null> {
  if (!ctx.instagramInfo) return null;
  if (String(ctx.instagramInfo.threadType || "").toLowerCase() === "comment") {
    return null;
  }

  const senderId = ctx.instagramInfo.pageId;
  if (!senderId) return null;
  // Instagram's only file type is PDF; other documents would always be rejected.
  if (mediaType === "document" && !/\.pdf(?:$|[?#])/i.test(mediaUrl)) {
    airiReplyLogger.warn("airi.reply.delivery", {
      conversationId: String(ctx.conversation._id),
      note: "instagram_unsupported_document_skipped",
    });
    return null;
  }
  const window = await checkMessagingWindowForConversation(ctx.conversation);
  if (!window.isWithinWindow) return null;

  const authMethod = String(ctx.instagramInfo.authMethod || "");
  const graphApiBase = resolveInstagramGraphBase(authMethod);
  const url = `${graphApiBase}/${encodeURIComponent(senderId)}/messages`;

  const response = await postInstagramGraph(
    url,
    ctx.instagramInfo.accessToken,
    {
      recipient: { id: ctx.instagramInfo.recipientId },
      message: buildInstagramAttachmentMessagePayload({
        mediaType,
        url: await resolveCustomerMediaReadUrl(
          mediaUrl,
          CUSTOMER_MEDIA_PROVIDER_TTL_SECONDS
        ),
      }),
    }
  );

  if (!response.ok) {
    await throwInstagramGraphFailure(response, url, {
      kind: "dm",
      isAttachment: true,
    });
  }

  return {
    id: await readInstagramSendId(response),
    date: new Date(),
  };
}

async function notifyClients(
  ctx: OutboundContext,
  msg: InstanceType<typeof Message>
) {
  const isWidget = ctx.type === "web_widget";
  const channel = getRealtimeChannelNameForConversation(
    ctx.type,
    String(ctx.conversation._id)
  );
  const event = isWidget ? "message.new" : "new-message";

  const payload = isWidget
    ? {
        id: msg._id.toString(),
        conversationId: ctx.conversation._id.toString(),
        workspaceId: ctx.conversation.workspaceId,
        text: msg.text,
        imageUrl: msg.imageUrl || undefined,
        mediaUrl: msg.imageUrl || undefined,
        mediaType: msg.mediaType || undefined,
        direction: "outbound",
        timestamp: msg.date.toISOString(),
        authorName: "Airi",
      }
    : await Message.findById(msg._id).populate("author", "firstName isBot");

  await triggerRealtimeEvent(channel, event, payload);

  if (isWidget) {
    await triggerRealtimeEvent(channel, "airi.typing.stop", {
      workspaceId: ctx.conversation.workspaceId,
    }).catch(() => {});

    // web_widget live events flow on `conversation-{id}` (`message.new`), but the
    // panel conversation thread binds the generic `private-conversation-{id}`
    // (`new-message`) channel. Mirror the outbound reply there so an open panel
    // thread updates live, and refresh the requests list preview after the bot
    // reply (inbound already triggers this; outbound did not).
    const panelChannel = `private-conversation-${ctx.conversation._id.toString()}`;
    const panelPayload = await Message.findById(msg._id).populate(
      "author",
      "firstName isBot"
    );
    await triggerRealtimeEvent(panelChannel, "new-message", panelPayload).catch(
      () => {}
    );

    void import("@/lib/realtime-updates")
      .then(({ triggerConversationRealtime }) =>
        triggerConversationRealtime(ctx.conversation._id.toString(), false)
      )
      .catch(() => {});
  }
}

// Text and attachments of one reply share one source read.
const resolvedTelegramBotTokens = new WeakMap<OutboundContext, string>();

async function resolveTelegramBotToken(
  ctx: OutboundContext
): Promise<string | undefined> {
  if (ctx.botToken) {
    return ctx.botToken;
  }
  const resolved = resolvedTelegramBotTokens.get(ctx);
  if (resolved) {
    return resolved;
  }

  const sourceId = ctx.conversation?.sourceId || ctx.chatDocument?.sourceId;
  if (!sourceId) {
    return undefined;
  }

  // Captured Temporal deliveries carry no token, so this read is on every
  // send. A failed read must fail the send, not fall back to the platform bot.
  const result = await fetchSourceWithCredentialsResult(
    String(sourceId),
    "telegram"
  );
  if (!result.ok) {
    airiReplyLogger.error("airi.reply.delivery", result.error, {
      note: "telegram_bot_token_resolve_failed",
      conversationId: String(ctx.conversation._id),
      sourceId: String(sourceId),
    });
    throw new Error("Telegram bot token could not be loaded");
  }

  const credentials =
    result.source && isTelegramSource(result.source)
      ? result.source.credentials
      : null;
  const token = readTelegramBotToken(credentials);
  // A saved token this key cannot decrypt is the wrong ENCRYPTION_SECRET,
  // not a source without its own bot.
  if (!token && hasStoredTelegramBotToken(credentials)) {
    throw new Error("Telegram bot token could not be decrypted");
  }
  if (token) resolvedTelegramBotTokens.set(ctx, token);
  return token || undefined;
}
