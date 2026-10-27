import {
  buildCacheKey,
  cache,
  invalidateConversationCache,
  invalidateRequestsForWorkspace,
} from "@/lib/cache";
import { ensureCustomerForConversation } from "@/lib/customers/service";
import {
  buildCompanyConversationVisibilityExceededResponse,
  getCompanyConversationVisibilityGate,
  getHiddenConversationPlanGateResponse,
  isConversationVisibleForPlan,
} from "@/lib/limits/company-limits";
import connectDB from "@/lib/mongoose";
import {
  createRequestLogger,
  type ServerLogContext,
} from "@/lib/observability/server-logs";
import { buildConversationMessagingWindowStatus } from "@/lib/conversation-window-status";
import {
  enrichStoredWhatsAppServiceMessagePreviewMedia,
  resolveStoredWhatsAppServiceMessagePrimaryMediaUrl,
} from "@/lib/scenarios/scenario-asset-media-enrichment";
import { buildScenarioFormResponseFieldMetadata } from "@/lib/scenarios/scenario-form-response-metadata";
import { withCustomerMediaReadUrls } from "@/lib/media/customer-media-read-url";
import { getUserProfilesByIds } from "@/lib/supabase/company-users";
import { createClient } from "@/lib/supabase/server";
import {
  getSupabaseRouteAuth,
  isSupabaseRouteAuthError,
} from "@/lib/supabase/route-auth";
import { getWorkspaceFeatureFlags } from "@/lib/workspace-feature-flags";
import Chat from "@/models/chat";
import { Conversation } from "@/models/conversation";
import Customer from "@/models/customer";
import Message from "@/models/message";
import { Scenario } from "@/models/scenario";
import { ScenarioFlowEvent } from "@/models/scenario-flow-event";
import User from "@/models/user";
import WhatsAppCallCommand from "@/models/whatsapp-call-command";
import type {
  WhatsAppCallCommandAction,
  WhatsAppCallCommandStatus,
} from "@/models/whatsapp-call-command";
import WhatsAppCallSession from "@/models/whatsapp-call-session";
import type { ConversationDocument, MessageDocument } from "@/types/models";
import {
  readScenarioActionFormForFlow,
  type ScenarioActionForm,
} from "@icecore/scenario-contracts";
import type {
  StoredMessageEditMeta,
  StoredWhatsAppFlowFieldMetadataPreview,
} from "@icecore/shared/types/message-preview";
import type { TelegramStoredMessageMeta } from "@icecore/shared/types/telegram";
import type { CacheReadResult } from "@icecore/shared/lib/cache";
import mongoose from "mongoose";
import { after, NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { isRecord } from "@icecore/shared/lib/value-utils";
import {
  errorMessageResponse,
  readJsonBodyOrResponse,
} from "@/lib/api/json-body";

type Params = Promise<{ id: string }>;
type MeasureConversationStage = <T>(
  stage: string,
  operation: () => T | PromiseLike<T>
) => Promise<T>;
type ConversationReadDiagnostics = {
  event: ServerLogContext;
  measure: MeasureConversationStage;
};
type LeanMessageResult = {
  _id: mongoose.Types.ObjectId | string;
  messageId?: string | null;
  text?: string;
  date: Date | string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  direction?: "inbound" | "outbound";
  imageUrl?: string | null;
  attachments?: MessageDocument["attachments"];
  mediaType?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  reactions?: MessageDocument["reactions"];
  editMeta?: StoredMessageEditMeta | null;
  whatsappFlow?: MessageDocument["whatsappFlow"];
  whatsappFlowReply?: MessageDocument["whatsappFlowReply"];
  whatsappServiceMessage?: MessageDocument["whatsappServiceMessage"];
  whatsappTemplate?: MessageDocument["whatsappTemplate"];
  whatsappCtaLink?: MessageDocument["whatsappCtaLink"];
  groundedReplyOptions?: MessageDocument["groundedReplyOptions"];
  whatsappMeta?: MessageDocument["whatsappMeta"] | null;
  whatsappGroup?: MessageDocument["whatsappGroup"] | null;
  telegramMeta?: TelegramStoredMessageMeta | null;
  whatsappLocation?: MessageDocument["whatsappLocation"] | null;
  whatsappContacts?: MessageDocument["whatsappContacts"] | null;
  whatsappProductInquiry?: MessageDocument["whatsappProductInquiry"] | null;
  whatsappOrder?: MessageDocument["whatsappOrder"] | null;
  whatsappReferral?: MessageDocument["whatsappReferral"] | null;
  delivery?: MessageDocument["delivery"] | null;
  conversation?: mongoose.Types.ObjectId | string;
  author?: unknown;
  origin?: MessageDocument["origin"] | null;
};
type AccessRow = {
  user_id: string;
  email?: string | null;
};

export const CONVERSATION_DETAIL_SELECT_FIELDS = [
  "_id",
  "workspaceId",
  "chat",
  "user",
  "business_connection_id",
  "message_count",
  "status",
  "channel",
  "customerId",
  "sourceId",
  "customerLinkedAt",
  "customerLinkedBy",
  "customerLinkMethod",
  "customerLinkConfidence",
  "lastMessageAt",
  "last_outbound_at",
  "last_inbound_at",
  "first_inbound_at",
  "subject",
  "rename",
  "quick_note",
  "quick_note_updated_at",
  "quick_note_updated_by",
  "participants",
  "external_thread",
  "airi_context_memory",
  "classification.category",
  "classification.priority",
  "classification.sentiment",
  "classification.summary",
  "classification.action",
  "classification.tags",
  "classification.confidence",
  "classification_error",
  "extracted_entities",
  "key_moments",
  "interaction_metrics",
  "engagement_metrics",
  "agent_performance_scorecard",
  "is_best_practice",
  "is_qa_analyzed",
  "customer_satisfaction_score",
  "customer_satisfaction_comment",
  "awaiting_csat",
  "csat_timeout_closed",
  "handled_by_agent_id",
  "airi_bot_enabled",
  "airi_scenarios_enabled",
  "airi_coach_enabled",
  "airi_handoff_active",
  "airi_handoff_started_at",
  "airi_handoff_source",
  "airi_handoff_reason",
  "airi_last_suppressed_at",
  "airi_last_suppressed_reason",
  "airi_last_suppressed_manager_user_id",
  "airi_last_suppressed_message_id",
  "airi_scenario_state",
  "airi_enabled",
  "preferred_language",
  "page_url",
  "visitor_id",
  "internal_labels",
  "last_bulk_sent_at",
  "whatsapp_opt_in",
  "whatsappReferral",
  "whatsappGroup",
  "followUpAudience",
  "createdAt",
  "updatedAt",
] as const;

export const CONVERSATION_CHAT_SELECT_FIELDS = [
  "_id",
  "workspaceId",
  "chat",
  "user",
  "message_count",
  "status",
  "channel",
  "lastMessageAt",
  "last_inbound_at",
  "rename",
  "quick_note",
  "quick_note_updated_at",
  "quick_note_updated_by",
  "external_thread",
  "airi_bot_enabled",
  "airi_scenarios_enabled",
  "airi_coach_enabled",
  "airi_handoff_active",
  "airi_handoff_started_at",
  "airi_last_suppressed_at",
  "airi_last_suppressed_reason",
  "airi_last_suppressed_manager_user_id",
  "airi_last_suppressed_message_id",
  "airi_scenario_state",
  "airi_enabled",
  "preferred_language",
  "whatsappReferral",
  "whatsappGroup",
  "createdAt",
  "updatedAt",
] as const;

export const CONVERSATION_DETAIL_EXCLUDED_FIELDS = [
  "embedding",
  "embeddingProvider",
  "embeddingModel",
  "embeddingTaskType",
  "embeddingDimensions",
  "history_summary",
  "shadow_classification",
  "classification_meta",
  "messages",
  "bulk_campaign_history",
] as const;

const CONVERSATION_DETAIL_SELECT = CONVERSATION_DETAIL_SELECT_FIELDS.join(" ");
const CONVERSATION_CHAT_SELECT = CONVERSATION_CHAT_SELECT_FIELDS.join(" ");
// Message-only pages read just what scopes access, WhatsApp extras and caching.
const CONVERSATION_MESSAGES_ONLY_SELECT =
  "_id workspaceId channel message_count lastMessageAt";

// Measured serialized cache hits exceed 350 ms; allow transfer and decoding.
const CONVERSATION_CACHE_GET_TIMEOUT_MS = 550;
const CUSTOMER_SUMMARY_LINK_TIMEOUT_MS = 150;

const DEFAULT_CUSTOMER_FEATURE_FLAGS = {
  customer_identity: false,
  customer_behavioral_profile: false,
};
const CONVERSATION_MESSAGE_SELECT =
  "_id messageId text date createdAt updatedAt direction imageUrl attachments mediaType mimeType fileName fileSize reactions editMeta origin whatsappFlow whatsappFlowReply whatsappServiceMessage whatsappTemplate whatsappCtaLink groundedReplyOptions whatsappLocation whatsappContacts whatsappProductInquiry whatsappOrder whatsappReferral whatsappMeta whatsappGroup delivery telegramMeta conversation author";

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>(resolve => {
        timeout = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function getConversationCache(
  cacheKey: string,
  onStatus: (status: CacheReadResult<unknown>["status"] | "timeout") => void
): Promise<unknown | null> {
  const result = await withTimeout<
    CacheReadResult<unknown> | { status: "timeout" }
  >(
    // Preserve development's Redis-to-memory fallback. Production has no
    // memory fallback, so its status read can distinguish outage from miss.
    (cache.memoryEnabled
      ? cache
          .get<unknown>(cacheKey)
          .then(value =>
            value === null
              ? { status: "miss" as const }
              : { status: "hit" as const, value }
          )
      : cache.readWithStatus<unknown>(cacheKey)
    ).catch(() => ({ status: "unavailable" as const })),
    CONVERSATION_CACHE_GET_TIMEOUT_MS,
    { status: "timeout" }
  );
  onStatus(result.status);
  return result.status === "hit" ? result.value : null;
}

function buildConversationCacheKey({
  workspaceId,
  id,
  page,
  limit,
  messagesOnly,
  chatView,
}: {
  workspaceId: string;
  id: string;
  page: number;
  limit: number;
  messagesOnly: boolean;
  chatView: boolean;
}) {
  return buildCacheKey("conversation", [
    String(workspaceId),
    String(id),
    `p${page}`,
    `l${limit}`,
    messagesOnly ? "m1" : "m0",
    // v4: group sender + CTA/grounded + forwarded meta fields.
    chatView ? "chat-v4" : "full-v4",
  ]);
}

function getKnownMessageTotal(params: {
  conversation: ConversationDocument;
  skip: number;
  pageMessageCount: number;
  hasMoreByExtraRow: boolean;
}): number | null {
  const observedMinimum =
    params.skip + params.pageMessageCount + (params.hasMoreByExtraRow ? 1 : 0);
  const denormalizedTotal =
    typeof params.conversation.message_count === "number" &&
    Number.isFinite(params.conversation.message_count)
      ? Math.max(0, Math.floor(params.conversation.message_count))
      : null;

  if (denormalizedTotal === null) {
    return observedMinimum > 0 ? observedMinimum : null;
  }

  return Math.max(denormalizedTotal, observedMinimum);
}

export function shouldCacheConversationResponse(params: {
  page: number;
  messagesLength: number;
  totalMessages: number | null;
  conversationMessageCount?: number | null;
  lastMessageAt?: Date | string | null;
}): boolean {
  if (params.page !== 1 || params.messagesLength > 0) {
    return true;
  }

  const knownMessageCount =
    typeof params.totalMessages === "number" &&
    Number.isFinite(params.totalMessages)
      ? params.totalMessages
      : typeof params.conversationMessageCount === "number" &&
          Number.isFinite(params.conversationMessageCount)
        ? params.conversationMessageCount
        : null;

  return !(
    (knownMessageCount !== null && knownMessageCount > 0) ||
    Boolean(params.lastMessageAt)
  );
}

// The cache keeps stored media references; each response signs them afresh
// (message media, message authors' and the customer's avatars).
async function withSignedMessageMedia<T>(responseData: T): Promise<T> {
  if (!responseData || typeof responseData !== "object") return responseData;
  const [signed] = await withCustomerMediaReadUrls([responseData]);
  const messages = (signed as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return signed;
  return {
    ...signed,
    messages: await withCustomerMediaReadUrls(messages),
  };
}

function setConversationCache(
  cacheKey: string,
  value: unknown,
  ttlSeconds: number,
  context: { conversationId: string; label: string }
): Promise<void> {
  const write = cache.set(cacheKey, value, ttlSeconds).catch(cacheError => {
    console.error(`[api/conversations] cache set failed (${context.label})`, {
      conversationId: context.conversationId,
      error:
        cacheError instanceof Error ? cacheError.message : String(cacheError),
    });
  });
  try {
    // Retain the actual SET, rather than a deadline race that could settle
    // before Redis stores the response. Cache writes never hold the chat open.
    after(write);
  } catch {
    // Outside a request scope the owned write still settles on its own.
  }
  return write;
}

async function findConversationRef<TRecord>(
  model: {
    findOne: (filter: Record<string, unknown>) => {
      select: (select: string) => {
        lean: () => PromiseLike<TRecord | null>;
      };
    };
  },
  value: unknown,
  select: string
): Promise<TRecord | unknown | null> {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "object") {
    return value as TRecord;
  }

  try {
    return (await model
      .findOne({ _id: value })
      .select(select)
      .lean()) as TRecord | null;
  } catch {
    return value;
  }
}

type LeanScenarioFlowEventResult = {
  outboundMessageId?: string | null;
  flowId?: string | null;
  flowToken?: string | null;
  scenarioId?: string | null;
  scenarioName?: string | null;
  actionNodeId?: string | null;
  eventType?: "sent" | "read" | "submitted" | string;
  responseJson?: string | null;
};

type LeanScenarioResult = {
  _id: mongoose.Types.ObjectId | string;
  nodes?: unknown;
};
type LeanAuthorResult = {
  _id: unknown;
  firstName?: string;
  lastName?: string;
  username?: string;
  avatar_url?: string;
  isBot?: boolean;
};
type LeanWhatsAppCallSessionResult = {
  _id?: unknown;
  callId?: string | null;
  state?: string | null;
  latestEvent?: string | null;
  latestStatus?: string | null;
  direction?: string | null;
  phoneNumberId?: string | null;
  contactName?: string | null;
  contactUsername?: string | null;
  durationSeconds?: number | null;
  errorCode?: number | null;
  errorMessage?: string | null;
  firstSeenAt?: Date | string | null;
  answeredAt?: Date | string | null;
  endedAt?: Date | string | null;
  lastProviderUpdateAt?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};
type LeanWhatsAppCallCommandResult = {
  _id?: unknown;
  callSessionId?: unknown;
  action?: WhatsAppCallCommandAction | string | null;
  status?: WhatsAppCallCommandStatus | string | null;
  providerError?: unknown;
  correlationId?: string | null;
  createdAt?: Date | string | null;
  sentAt?: Date | string | null;
  failedAt?: Date | string | null;
};

async function readWhatsAppCallHistory(
  params: {
    workspaceId: string;
    conversationId: string;
    enabled: boolean;
  },
  measure: MeasureConversationStage
) {
  const latestCallCommandBySessionId = new Map<
    string,
    LeanWhatsAppCallCommandResult
  >();
  if (!params.enabled) {
    return {
      callSessions: [] as LeanWhatsAppCallSessionResult[],
      latestCallCommandBySessionId,
    };
  }

  const callSessions = await measure("call_sessions", () =>
    WhatsAppCallSession.find({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
    })
      .sort({ lastProviderUpdateAt: -1, updatedAt: -1 })
      .limit(5)
      .select(
        "_id callId state latestEvent latestStatus direction phoneNumberId contactName contactUsername durationSeconds errorCode errorMessage firstSeenAt answeredAt endedAt lastProviderUpdateAt createdAt updatedAt"
      )
      .lean<LeanWhatsAppCallSessionResult[]>()
      .exec()
  );
  const callSessionIds = callSessions
    .map(session => session._id)
    .filter(sessionId => sessionId != null);

  if (callSessionIds.length > 0) {
    const latestCallCommands = await measure("call_commands", () =>
      WhatsAppCallCommand.find({
        workspaceId: params.workspaceId,
        callSessionId: { $in: callSessionIds },
      })
        .sort({ createdAt: -1 })
        .limit(callSessionIds.length * 3)
        .select(
          "_id callSessionId action status providerError correlationId createdAt sentAt failedAt"
        )
        .lean<LeanWhatsAppCallCommandResult[]>()
        .exec()
    );

    for (const command of latestCallCommands) {
      const callSessionId =
        command.callSessionId != null ? String(command.callSessionId) : "";
      if (!callSessionId || latestCallCommandBySessionId.has(callSessionId)) {
        continue;
      }
      latestCallCommandBySessionId.set(callSessionId, command);
    }
  }

  return { callSessions, latestCallCommandBySessionId };
}

const FLOW_EVENT_STATUS_PRIORITY: Record<string, number> = {
  sent: 1,
  read: 2,
  submitted: 3,
};

function mergeWhatsAppFlowMeta(
  messageFlow: MessageDocument["whatsappFlow"] | undefined,
  eventFlow?: {
    flowId?: string | null;
    flowToken?: string | null;
    scenarioId?: string | null;
    scenarioName?: string | null;
    actionNodeId?: string | null;
    status?: "sent" | "read" | "submitted" | null;
    responseJson?: string | null;
  } | null,
  fallbackResponseFieldMetadata?:
    | StoredWhatsAppFlowFieldMetadataPreview[]
    | null
) {
  if (!messageFlow && !eventFlow) {
    return null;
  }

  return {
    flowId: messageFlow?.flowId || eventFlow?.flowId || null,
    flowToken: messageFlow?.flowToken || eventFlow?.flowToken || null,
    flowCta: messageFlow?.flowCta || null,
    headerText: messageFlow?.headerText || null,
    bodyText: messageFlow?.bodyText || null,
    footerText: messageFlow?.footerText || null,
    responseFieldMetadata:
      messageFlow?.responseFieldMetadata ||
      fallbackResponseFieldMetadata ||
      null,
    flowActionType: messageFlow?.flowActionType || null,
    flowActionPayload: messageFlow?.flowActionPayload || null,
    scenarioId: messageFlow?.scenarioId || eventFlow?.scenarioId || null,
    scenarioName: messageFlow?.scenarioName || eventFlow?.scenarioName || null,
    actionNodeId: messageFlow?.actionNodeId || eventFlow?.actionNodeId || null,
    status: messageFlow?.status || eventFlow?.status || null,
    responseJson: messageFlow?.responseJson || eventFlow?.responseJson || null,
  };
}

function serializeWhatsAppCallCommand(
  command?: LeanWhatsAppCallCommandResult | null
) {
  if (!command?._id) return null;

  return {
    id: String(command._id),
    callSessionId:
      command.callSessionId != null ? String(command.callSessionId) : "",
    action: command.action || null,
    status: command.status || "pending",
    providerError: command.providerError ?? null,
    correlationId: command.correlationId || null,
    createdAt: command.createdAt || null,
    sentAt: command.sentAt || null,
    failedAt: command.failedAt || null,
  };
}

function serializeWhatsAppCallSession(
  session: LeanWhatsAppCallSessionResult,
  latestCommand?: LeanWhatsAppCallCommandResult | null
) {
  return {
    _id: session._id != null ? String(session._id) : "",
    callId: session.callId || null,
    state: session.state || "unknown",
    latestEvent: session.latestEvent || null,
    latestStatus: session.latestStatus || null,
    direction: session.direction || null,
    phoneNumberId: session.phoneNumberId || null,
    contactName: session.contactName || null,
    contactUsername: session.contactUsername || null,
    durationSeconds:
      typeof session.durationSeconds === "number"
        ? session.durationSeconds
        : null,
    errorCode: typeof session.errorCode === "number" ? session.errorCode : null,
    errorMessage: session.errorMessage || null,
    firstSeenAt: session.firstSeenAt || null,
    answeredAt: session.answeredAt || null,
    endedAt: session.endedAt || null,
    lastProviderUpdateAt: session.lastProviderUpdateAt || null,
    createdAt: session.createdAt || null,
    updatedAt: session.updatedAt || null,
    latestCommand: serializeWhatsAppCallCommand(latestCommand),
  };
}

function getScenarioActionForm(
  scenario: LeanScenarioResult,
  actionNodeId: string | null,
  flowId: string | null
): ScenarioActionForm | null {
  const trimmedActionNodeId = actionNodeId?.trim();
  const nodes = Array.isArray(scenario.nodes) ? scenario.nodes : [];

  if (trimmedActionNodeId) {
    for (const node of nodes) {
      if (!isRecord(node)) continue;
      if (String(node.id || "").trim() !== trimmedActionNodeId) continue;
      return readScenarioActionFormForFlow(node.data, flowId);
    }
  }

  return null;
}

export async function GET(request: Request, { params }: { params: Params }) {
  const startedAt = performance.now();
  const logger = createRequestLogger("api.conversations.detail", request, {
    route: "/api/conversations/[id]",
  });
  const event: ServerLogContext = {
    statusCode: 500,
    outcome: "error",
    page: null,
    limit: null,
    view: null,
    messagesOnly: null,
    cachePath: "none",
    messageCount: null,
  };
  const stages: Record<
    string,
    {
      startedAt: number;
      durationMs?: number;
      outcome: "pending" | "success" | "error";
    }
  > = {};
  const measure: MeasureConversationStage = async (stage, operation) => {
    const timing = {
      startedAt: performance.now(),
      outcome: "pending" as const,
    };
    stages[stage] = timing;
    try {
      const result = await operation();
      stages[stage].outcome = "success";
      return result;
    } catch (error) {
      stages[stage].outcome = "error";
      throw error;
    } finally {
      stages[stage].durationMs = performance.now() - timing.startedAt;
    }
  };

  try {
    const response = await getConversationResponse(
      request,
      { params },
      { event, measure }
    );
    event.statusCode = response.status;
    event.outcome = response.ok
      ? "success"
      : response.status === 404
        ? "not_found"
        : response.status < 500
          ? "denied"
          : "error";
    return response;
  } finally {
    const completedAt = performance.now();
    event.durationMs = completedAt - startedAt;
    // Operations can overlap. Pending work at an early return is reported as
    // pending rather than pretending the response waited for it to finish.
    event.stageTimings = Object.fromEntries(
      Object.entries(stages).map(([stage, timing]) => [
        stage,
        {
          durationMs: timing.durationMs ?? completedAt - timing.startedAt,
          outcome: timing.outcome,
        },
      ])
    );
    if (event.outcome === "error") {
      // Exception messages may contain provider URLs or customer data. The
      // failed stage and status are sufficient for this performance event.
      logger.error("Conversation detail completed", undefined, event);
    } else {
      logger.success("Conversation detail completed", event);
    }
  }
}

// Keep the existing response/error boundaries intact; diagnostics observe
// each operation without changing its authorization or hydration ownership.
async function getConversationResponse(
  request: Request,
  { params }: { params: Params },
  { event, measure }: ConversationReadDiagnostics
) {
  const [{ id }, auth] = await Promise.all([
    params,
    measure("auth", () => getSupabaseRouteAuth(request)),
  ]);

  if (!mongoose.Types.ObjectId.isValid(id)) {
    event.denialReason = "invalid_id";
    return NextResponse.json(
      { error: "Conversation not found" },
      { status: 404 }
    );
  }

  if (isSupabaseRouteAuthError(auth)) {
    event.denialReason = "auth_failed";
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { supabase, user } = auth;

  const { searchParams } = new URL(request.url);
  const parsedPage = parseInt(searchParams.get("page") || "1", 10);
  const parsedLimit = parseInt(searchParams.get("limit") || "30", 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 100)
      : 30;
  const skip = (page - 1) * limit;
  const messagesOnly =
    searchParams.get("messagesOnly") === "1" ||
    searchParams.get("messagesOnly") === "true";
  const detailView = searchParams.get("view");
  const chatView = detailView === "chat";
  const requestedWorkspaceId = searchParams.get("workspaceId")?.trim() || "";
  Object.assign(event, {
    page,
    limit,
    view: chatView ? "chat" : "full",
    messagesOnly,
  });
  let fastCacheMissKey: string | null = null;
  const readRequestedWorkspaceMembership = () =>
    measure("fast_access", () =>
      supabase
        .from("company_users")
        .select("workspace_id")
        .eq("workspace_id", requestedWorkspaceId)
        .eq("user_id", user.id)
        .maybeSingle()
    );
  let requestedWorkspaceMembershipPromise: Promise<
    PromiseSettledResult<
      Awaited<ReturnType<typeof readRequestedWorkspaceMembership>>
    >
  > | null = null;

  if (requestedWorkspaceId) {
    // This is the same access lookup used by a fast cache hit. Start it while
    // cache/Mongo work runs; reuse only a verified, matching chat/page lookup.
    if (chatView || messagesOnly) {
      requestedWorkspaceMembershipPromise =
        readRequestedWorkspaceMembership().then(
          value => ({ status: "fulfilled" as const, value }),
          reason => ({ status: "rejected" as const, reason })
        );
    }
    const fastCacheKey = buildConversationCacheKey({
      workspaceId: requestedWorkspaceId,
      id,
      page,
      limit,
      messagesOnly,
      chatView,
    });

    const cached = await measure("fast_cache_read", () =>
      getConversationCache(fastCacheKey, status => {
        event.fastCacheReadStatus = status;
      })
    );

    if (cached) {
      event.cachePath = "workspace_hit";
      const prefetchedMembership = requestedWorkspaceMembershipPromise
        ? await requestedWorkspaceMembershipPromise
        : null;
      if (prefetchedMembership?.status === "rejected") {
        // The original fast-hit membership lookup was outside the canonical
        // response catch. Keep its thrown-error boundary while owning early errors.
        throw prefetchedMembership.reason;
      }
      const membershipResult = prefetchedMembership
        ? prefetchedMembership.value
        : await readRequestedWorkspaceMembership();

      if (
        membershipResult &&
        !membershipResult.error &&
        membershipResult.data
      ) {
        const planGate = await measure("fast_plan_gate", () =>
          getCompanyConversationVisibilityGate(supabase, requestedWorkspaceId)
        );
        if (!isConversationVisibleForPlan(planGate, id)) {
          event.denialReason = "plan_visibility_denied";
          return buildCompanyConversationVisibilityExceededResponse(planGate);
        }
        event.messageCount = Array.isArray(
          (cached as { messages?: unknown }).messages
        )
          ? (cached as { messages: unknown[] }).messages.length
          : null;
        return NextResponse.json(await withSignedMessageMedia(cached));
      }
      event.cachePath = "workspace_hit_rejected";
    } else {
      event.cachePath = "workspace_miss";
      fastCacheMissKey = fastCacheKey;
    }
  }

  try {
    await measure("mongo_connect", () => connectDB());

    const conversationSelect = messagesOnly
      ? CONVERSATION_MESSAGES_ONLY_SELECT
      : chatView
        ? CONVERSATION_CHAT_SELECT
        : CONVERSATION_DETAIL_SELECT;

    const queryMessages = (conversationId: unknown) =>
      measure("messages", () =>
        Message.find({ conversation: conversationId })
          .sort({ date: -1 })
          .skip(skip)
          .limit(limit + 1)
          .select(CONVERSATION_MESSAGE_SELECT)
          .lean()
          .exec()
      );

    const earlyMessagesPromise = fastCacheMissKey ? queryMessages(id) : null;

    const conversation = (await measure("conversation", () =>
      Conversation.findById(id).select(conversationSelect).lean().exec()
    )) as ConversationDocument | null;

    if (!conversation) {
      event.denialReason = "conversation_missing";
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    const workspaceId = conversation.workspaceId;
    const handledByAgentId =
      messagesOnly || chatView ? null : conversation.handled_by_agent_id;

    const userIdsToCheck = [user.id];
    if (handledByAgentId && handledByAgentId !== user.id) {
      userIdsToCheck.push(handledByAgentId);
    }

    const readCanonicalAccess = () =>
      messagesOnly
        ? supabase
            .from("company_users")
            .select("workspace_id")
            .eq("workspace_id", workspaceId)
            .eq("user_id", user.id)
            .maybeSingle()
        : handledByAgentId
          ? supabase
              .from("company_users")
              .select("user_id, workspace_id, email")
              .eq("workspace_id", workspaceId)
              .in("user_id", userIdsToCheck)
          : supabase
              .from("company_users")
              .select("user_id, workspace_id")
              .eq("workspace_id", workspaceId)
              .in("user_id", userIdsToCheck);
    const accessPromise =
      requestedWorkspaceMembershipPromise &&
      workspaceId === requestedWorkspaceId &&
      (chatView || messagesOnly)
        ? requestedWorkspaceMembershipPromise.then<
            Awaited<ReturnType<typeof readCanonicalAccess>>
          >(result => {
            if (result.status === "rejected") return readCanonicalAccess();
            const membership = result.value;
            if (
              membership.error ||
              membership.data?.workspace_id !== workspaceId
            ) {
              return readCanonicalAccess();
            }
            // The fast query already filters by this authenticated user. Match
            // the existing canonical result shape without a second round trip.
            return messagesOnly
              ? membership
              : {
                  ...membership,
                  data: [{ user_id: user.id, workspace_id: workspaceId }],
                };
          })
        : readCanonicalAccess();

    const cacheKey = buildConversationCacheKey({
      workspaceId,
      id,
      page,
      limit,
      messagesOnly,
      chatView,
    });
    const cachedPromise =
      fastCacheMissKey === cacheKey
        ? Promise.resolve(null)
        : measure("cache_read", () =>
            getConversationCache(cacheKey, status => {
              event.cacheReadStatus = status;
            })
          ).then(cached => {
            event.cachePath = cached ? "ordinary_hit" : "ordinary_miss";
            return cached;
          });

    const accessAndAgentResult = await measure<Awaited<typeof accessPromise>>(
      "access",
      () => accessPromise
    );

    const hasAccess = messagesOnly
      ? Boolean((accessAndAgentResult as { data?: unknown }).data)
      : Boolean(
          Array.isArray((accessAndAgentResult as { data?: unknown }).data) &&
            (
              accessAndAgentResult as { data: Array<{ user_id: string }> }
            ).data.some(cu => cu.user_id === user.id)
        );

    if (!hasAccess) {
      event.denialReason = "workspace_access_denied";
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const planGate = await measure("plan_gate", () =>
      getCompanyConversationVisibilityGate(supabase, workspaceId)
    );
    if (!isConversationVisibleForPlan(planGate, id)) {
      event.denialReason = "plan_visibility_denied";
      return buildCompanyConversationVisibilityExceededResponse(planGate);
    }

    const cached = await cachedPromise;
    if (cached) {
      event.messageCount = Array.isArray(
        (cached as { messages?: unknown }).messages
      )
        ? (cached as { messages: unknown[] }).messages.length
        : null;
      return NextResponse.json(await withSignedMessageMedia(cached));
    }

    // Own early failures until the result is joined after message hydration.
    // Only the chat view renders the call banner.
    const callHistoryPromise = readWhatsAppCallHistory(
      {
        workspaceId,
        conversationId: id,
        enabled:
          !messagesOnly && chatView && conversation.channel === "whatsapp",
      },
      measure
    ).then(
      value => ({ status: "fulfilled" as const, value }),
      reason => ({ status: "rejected" as const, reason })
    );

    const featureFlagsPromise =
      !messagesOnly && !chatView
        ? measure("feature_flags", () =>
            getWorkspaceFeatureFlags(workspaceId, [
              "customer_identity",
              "customer_behavioral_profile",
            ])
          ).catch(() => DEFAULT_CUSTOMER_FEATURE_FLAGS)
        : Promise.resolve(DEFAULT_CUSTOMER_FEATURE_FLAGS);

    const messagingWindowPromise =
      !messagesOnly && chatView
        ? measure("messaging_window", () =>
            buildConversationMessagingWindowStatus(conversation)
          ).catch(() => null)
        : Promise.resolve(null);

    const messagesPromise =
      earlyMessagesPromise ?? queryMessages(conversation._id);

    const chatAndUserPromise = (
      messagesOnly
        ? Promise.resolve<[unknown, unknown]>([null, null])
        : (Promise.all([
            measure("chat", () =>
              findConversationRef<{
                _id: unknown;
                type?: string;
                title?: string;
                first_name?: string;
                last_name?: string;
                username?: string;
                sourceId?: string;
                businessConnectionId?: string;
                is_forum?: boolean;
                whatsapp?: {
                  waId?: string | null;
                  previousWaIds?: string[] | null;
                } | null;
              }>(
                Chat,
                conversation.chat,
                "_id type title first_name last_name username sourceId businessConnectionId is_forum whatsapp.waId whatsapp.previousWaIds whatsappGroup.groupId whatsappGroup.subject"
              )
            ),
            measure("user", () =>
              findConversationRef<{
                _id: unknown;
                firstName?: string;
                lastName?: string;
                username?: string;
                avatar_url?: string;
              }>(
                User,
                conversation.user,
                "_id firstName lastName username avatar_url"
              )
            ),
          ]) as Promise<[unknown, unknown]>)
    ).then(
      value => ({ status: "fulfilled" as const, value }),
      reason => ({ status: "rejected" as const, reason })
    );

    const rawMessages = await messagesPromise;

    const rawMessageRows = (rawMessages ||
      []) as unknown as LeanMessageResult[];
    const hasMoreByExtraRow = rawMessageRows.length > limit;
    const pageMessageRows = rawMessageRows.slice(0, limit);
    const shouldLoadWhatsAppMessageExtras = conversation.channel === "whatsapp";
    const outboundPlatformMessageIds = shouldLoadWhatsAppMessageExtras
      ? pageMessageRows
          .flatMap(msg =>
            msg.direction === "outbound" && typeof msg.messageId === "string"
              ? [msg.messageId.trim()]
              : []
          )
          .filter(Boolean)
      : [];

    const authorLookupValues: unknown[] = [];
    const seenAuthorKeys = new Set<string>();
    for (const msg of pageMessageRows) {
      if (!msg.author) continue;
      const key = String(msg.author);
      if (seenAuthorKeys.has(key)) continue;
      seenAuthorKeys.add(key);
      authorLookupValues.push(msg.author);
    }

    const authorDocsPromise = authorLookupValues.length
      ? measure("authors", () =>
          User.find({ _id: { $in: authorLookupValues } })
            .select("_id firstName lastName username avatar_url isBot")
            .lean<LeanAuthorResult[]>()
            .exec()
        )
      : Promise.resolve([]);

    const flowEventsPromise =
      shouldLoadWhatsAppMessageExtras && outboundPlatformMessageIds.length > 0
        ? measure("flow_events", () =>
            ScenarioFlowEvent.find({
              workspaceId,
              outboundMessageId: { $in: outboundPlatformMessageIds },
            })
              .select(
                "outboundMessageId flowId flowToken scenarioId scenarioName actionNodeId eventType responseJson"
              )
              .lean<LeanScenarioFlowEventResult[]>()
              .exec()
          )
        : Promise.resolve([]);
    const [authorDocs, flowEvents] = await Promise.all([
      authorDocsPromise,
      flowEventsPromise,
    ]);

    const authorMap = new Map<string, LeanAuthorResult>();
    for (const authorDoc of authorDocs) {
      authorMap.set(String(authorDoc._id), authorDoc);
    }

    const flowEventMap = new Map<
      string,
      {
        flowId?: string | null;
        flowToken?: string | null;
        scenarioId?: string | null;
        scenarioName?: string | null;
        actionNodeId?: string | null;
        status?: "sent" | "read" | "submitted" | null;
        responseJson?: string | null;
      }
    >();

    for (const event of flowEvents) {
      const outboundMessageId =
        typeof event.outboundMessageId === "string"
          ? event.outboundMessageId.trim()
          : "";
      if (!outboundMessageId) continue;

      const current = flowEventMap.get(outboundMessageId);
      const nextStatus =
        event.eventType === "submitted" ||
        event.eventType === "read" ||
        event.eventType === "sent"
          ? event.eventType
          : null;
      const currentPriority = current?.status
        ? FLOW_EVENT_STATUS_PRIORITY[current.status] || 0
        : 0;
      const nextPriority = nextStatus
        ? FLOW_EVENT_STATUS_PRIORITY[nextStatus] || 0
        : 0;

      flowEventMap.set(outboundMessageId, {
        flowId: current?.flowId || event.flowId || null,
        flowToken: current?.flowToken || event.flowToken || null,
        scenarioId: current?.scenarioId || event.scenarioId || null,
        scenarioName: current?.scenarioName || event.scenarioName || null,
        actionNodeId: current?.actionNodeId || event.actionNodeId || null,
        status:
          nextPriority >= currentPriority
            ? nextStatus
            : current?.status || null,
        responseJson:
          event.eventType === "submitted" && event.responseJson
            ? event.responseJson
            : current?.responseJson || null,
      });
    }

    const flowScenarioIds = new Set<string>();
    const messageFlowLookupRows: Array<{
      messageRowId: string;
      scenarioId: string;
      actionNodeId: string | null;
      flowId: string | null;
    }> = [];

    if (shouldLoadWhatsAppMessageExtras) {
      for (const msg of pageMessageRows) {
        const messageFlow = msg.whatsappFlow;
        if (
          messageFlow?.responseFieldMetadata &&
          messageFlow.responseFieldMetadata.length > 0
        ) {
          continue;
        }

        const flowMetaFromEvent =
          typeof msg.messageId === "string"
            ? flowEventMap.get(msg.messageId.trim()) || null
            : null;
        const scenarioId = (
          messageFlow?.scenarioId ||
          flowMetaFromEvent?.scenarioId ||
          ""
        ).trim();
        const actionNodeId =
          (
            messageFlow?.actionNodeId ||
            flowMetaFromEvent?.actionNodeId ||
            ""
          ).trim() || null;

        if (!scenarioId || !mongoose.Types.ObjectId.isValid(scenarioId)) {
          continue;
        }

        flowScenarioIds.add(scenarioId);
        messageFlowLookupRows.push({
          messageRowId: String(msg._id),
          scenarioId,
          actionNodeId,
          flowId: messageFlow?.flowId || flowMetaFromEvent?.flowId || null,
        });
      }
    }

    const scenarioDocs =
      shouldLoadWhatsAppMessageExtras && flowScenarioIds.size > 0
        ? ((await measure("flow_scenarios", () =>
            Scenario.find({
              workspaceId,
              _id: { $in: Array.from(flowScenarioIds) },
            })
              .select("_id nodes")
              .lean()
              .exec()
          )) as LeanScenarioResult[])
        : [];

    const scenarioMap = new Map<string, LeanScenarioResult>();
    for (const scenario of scenarioDocs) {
      scenarioMap.set(String(scenario._id), scenario);
    }

    const flowMetadataByMessageRowId = new Map<
      string,
      StoredWhatsAppFlowFieldMetadataPreview[]
    >();
    for (const lookup of messageFlowLookupRows) {
      const scenario = scenarioMap.get(lookup.scenarioId);
      if (!scenario) continue;
      const metadata = buildScenarioFormResponseFieldMetadata(
        getScenarioActionForm(scenario, lookup.actionNodeId, lookup.flowId)
      );
      if (metadata && metadata.length > 0) {
        flowMetadataByMessageRowId.set(lookup.messageRowId, metadata);
      }
    }

    const messages = (await measure("service_media", () =>
      Promise.all(
        pageMessageRows.map(async msg => {
          const authorDoc =
            msg.author !== undefined && msg.author !== null
              ? authorMap.get(String(msg.author))
              : undefined;
          const flowMetaFromEvent =
            typeof msg.messageId === "string"
              ? flowEventMap.get(msg.messageId.trim()) || null
              : null;
          const fallbackFlowMetadata = flowMetadataByMessageRowId.get(
            String(msg._id)
          );

          const whatsappServiceMessage = msg.whatsappServiceMessage
            ? await enrichStoredWhatsAppServiceMessagePreviewMedia({
                workspaceId,
                preview: msg.whatsappServiceMessage,
                includePrimaryAttachment: true,
              })
            : null;

          return {
            _id: msg._id,
            messageId: msg.messageId,
            text: msg.text,
            date: msg.date,
            createdAt: msg.createdAt,
            updatedAt: msg.updatedAt,
            direction: msg.direction,
            origin: msg.origin ?? null,
            attachments: msg.attachments,
            imageUrl: resolveStoredWhatsAppServiceMessagePrimaryMediaUrl({
              preview: whatsappServiceMessage,
              imageUrl: msg.imageUrl,
            }),
            mediaType: msg.mediaType,
            mimeType: msg.mimeType,
            fileName: msg.fileName,
            fileSize: msg.fileSize,
            reactions: msg.reactions,
            editMeta: msg.editMeta || null,
            whatsappFlow: mergeWhatsAppFlowMeta(
              msg.whatsappFlow,
              flowMetaFromEvent,
              fallbackFlowMetadata
            ),
            whatsappFlowReply: msg.whatsappFlowReply || null,
            whatsappServiceMessage,
            whatsappTemplate: msg.whatsappTemplate || null,
            whatsappCtaLink: msg.whatsappCtaLink || null,
            groundedReplyOptions: msg.groundedReplyOptions || null,
            whatsappLocation: msg.whatsappLocation || null,
            whatsappContacts: msg.whatsappContacts || null,
            whatsappProductInquiry: msg.whatsappProductInquiry || null,
            whatsappOrder: msg.whatsappOrder || null,
            whatsappReferral: msg.whatsappReferral || null,
            whatsappMeta: msg.whatsappMeta || null,
            whatsappGroup: msg.whatsappGroup || null,
            delivery: msg.delivery || null,
            telegramMeta: msg.telegramMeta,
            conversation: msg.conversation,
            author: authorDoc
              ? {
                  _id: authorDoc._id,
                  firstName: authorDoc.firstName,
                  lastName: authorDoc.lastName,
                  username: authorDoc.username,
                  avatar_url: authorDoc.avatar_url,
                  isBot: authorDoc.isBot,
                }
              : null,
          };
        })
      )
    )) as unknown as (
      | MessageDocument
      | (MessageDocument & { _id: mongoose.Types.ObjectId })
    )[];
    event.messageCount = messages.length;

    const callHistory = await callHistoryPromise;
    if (callHistory.status === "rejected") throw callHistory.reason;
    const { callSessions, latestCallCommandBySessionId } = callHistory.value;

    const totalMessages =
      page === 1
        ? getKnownMessageTotal({
            conversation,
            skip,
            pageMessageCount: messages.length,
            hasMoreByExtraRow,
          })
        : null;
    const hasMoreMessages =
      hasMoreByExtraRow ||
      (typeof totalMessages === "number"
        ? skip + messages.length < totalMessages
        : false);

    if (messagesOnly) {
      const responseData = {
        messages,
        message_pagination: {
          ...(typeof totalMessages === "number"
            ? { total: totalMessages }
            : {}),
          page,
          limit,
          has_more: hasMoreMessages,
        },
      };

      // Sign before the cache write starts: it must stay pending, never awaited.
      const responseBody = await withSignedMessageMedia(responseData);
      if (
        shouldCacheConversationResponse({
          page,
          messagesLength: messages.length,
          totalMessages,
          conversationMessageCount: conversation.message_count,
          lastMessageAt: conversation.lastMessageAt,
        })
      ) {
        void measure("cache_write", () =>
          setConversationCache(cacheKey, responseData, 10, {
            conversationId: id,
            label: "messagesOnly",
          })
        );
      }
      return NextResponse.json(responseBody);
    }

    let handledByAgent: {
      id: string;
      name: string;
      avatar_url: string | null;
    } | null = null;

    if (handledByAgentId) {
      const rows = Array.isArray(
        (accessAndAgentResult as { data?: unknown }).data
      )
        ? (accessAndAgentResult as { data: AccessRow[] }).data
        : [];
      const agentData =
        rows.find(cu => cu.user_id === handledByAgentId) ?? null;

      if (agentData) {
        const profile =
          (
            await measure("agent_profile", () =>
              getUserProfilesByIds(supabase, [handledByAgentId])
            )
          ).get(handledByAgentId) ?? null;

        handledByAgent = {
          id: agentData.user_id,
          name: profile?.full_name || agentData.email || "Unknown Agent",
          avatar_url: profile?.avatar_url || null,
        };
      }
    }

    const chatAndUserResult = await chatAndUserPromise;
    if (chatAndUserResult.status === "rejected") {
      throw chatAndUserResult.reason;
    }
    const [populatedChat, populatedUser] = chatAndUserResult.value;
    const [featureFlags, messagingWindow] = await Promise.all([
      featureFlagsPromise,
      messagingWindowPromise,
    ]);

    let customerSummary: {
      _id: string;
      displayName?: string | null;
      status?: string;
      currentFunnelStage?: string | null;
      lastInteractionAt?: Date | null;
      profileSummary?: Record<string, unknown> | null;
      behavioralProfile?: {
        status?: string | null;
        summary?: string | null;
      } | null;
    } | null = null;

    if (!chatView && featureFlags.customer_identity) {
      const existingCustomerId =
        conversation.customerId !== null &&
        conversation.customerId !== undefined
          ? String(conversation.customerId)
          : null;
      const fallbackCustomerId = !existingCustomerId
        ? await measure("customer_link", () =>
            withTimeout(
              ensureCustomerForConversation({
                conversationId: id,
              }).catch(() => null),
              CUSTOMER_SUMMARY_LINK_TIMEOUT_MS,
              null
            )
          )
        : null;
      const resolvedCustomerId =
        existingCustomerId ||
        (fallbackCustomerId &&
        typeof fallbackCustomerId === "object" &&
        "_id" in fallbackCustomerId
          ? String((fallbackCustomerId as { _id?: unknown })._id || "")
          : null);

      if (resolvedCustomerId) {
        customerSummary = await measure("customer", () =>
          Customer.findById(resolvedCustomerId)
            .select(
              "_id displayName status currentFunnelStage lastInteractionAt profileSummary behavioralProfile.status behavioralProfile.summary"
            )
            .lean<{
              _id: mongoose.Types.ObjectId;
              displayName?: string | null;
              status?: string;
              currentFunnelStage?: string | null;
              lastInteractionAt?: Date | null;
              profileSummary?: Record<string, unknown> | null;
              behavioralProfile?: {
                status?: string | null;
                summary?: string | null;
              } | null;
            } | null>()
            .then(customer =>
              customer
                ? {
                    ...customer,
                    _id: customer._id.toString(),
                  }
                : null
            )
        );
      }
    }

    // User _ids are Mixed (Telegram numbers, WhatsApp strings); clients
    // always get a user object with a string _id.
    const userRef = populatedUser || conversation.user;
    const userDoc = isRecord(userRef) ? (userRef as LeanAuthorResult) : null;
    const normalizedUser = {
      _id: String(userDoc?._id ?? (userRef || "unknown")),
      ...(userDoc?.firstName && { firstName: userDoc.firstName }),
      ...(userDoc?.lastName && { lastName: userDoc.lastName }),
      ...(userDoc?.username && { username: userDoc.username }),
      ...(userDoc?.avatar_url && { avatar_url: userDoc.avatar_url }),
    };

    const responseData = {
      ...conversation,
      chat: populatedChat || conversation.chat,
      user: normalizedUser,
      customer: customerSummary,
      customer_feature_flags: featureFlags,
      messages,
      whatsapp_call_sessions: callSessions
        .map(session =>
          serializeWhatsAppCallSession(
            session,
            latestCallCommandBySessionId.get(String(session._id))
          )
        )
        .filter(session => Boolean(session._id)),
      messaging_window: messagingWindow,
      message_pagination: {
        ...(typeof totalMessages === "number" ? { total: totalMessages } : {}),
        page,
        limit,
        has_more: hasMoreMessages,
      },
      handled_by_agent: handledByAgent,
    };

    const ttl = page === 1 ? 15 : 10;
    // Sign before the cache write starts: it must stay pending, never awaited.
    const responseBody = await withSignedMessageMedia(responseData);
    if (
      shouldCacheConversationResponse({
        page,
        messagesLength: messages.length,
        totalMessages,
        conversationMessageCount: conversation.message_count,
        lastMessageAt: conversation.lastMessageAt,
      })
    ) {
      void measure("cache_write", () =>
        setConversationCache(cacheKey, responseData, ttl, {
          conversationId: id,
          label: "detail",
        })
      );
    }

    return NextResponse.json(responseBody);
  } catch (error) {
    return errorMessageResponse(error, 500);
  }
}

export async function PATCH(request: Request, { params }: { params: Params }) {
  const [{ id }, supabase] = await Promise.all([params, createClient()]);

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return NextResponse.json(
      { error: "Invalid conversation id" },
      { status: 400 }
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const bodyResult = await readJsonBodyOrResponse(request);
  if (!bodyResult.ok) return bodyResult.response;
  const body = bodyResult.body as { rename?: string | null } | null;

  if (!body || !Object.prototype.hasOwnProperty.call(body, "rename")) {
    return NextResponse.json(
      { error: "Field 'rename' is required" },
      { status: 400 }
    );
  }

  if (typeof body.rename !== "string" && body.rename !== null) {
    return NextResponse.json(
      { error: "Field 'rename' must be a string or null" },
      { status: 400 }
    );
  }

  const normalizedRename =
    body.rename === null ? null : body.rename.trim().slice(0, 120);
  const renameToSave =
    normalizedRename && normalizedRename.length > 0 ? normalizedRename : null;

  try {
    await connectDB();

    const conversation = await Conversation.findById(id)
      .select("workspaceId")
      .lean<{ workspaceId: string } | null>();

    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    const { workspaceId } = conversation;
    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const planGateResponse = await getHiddenConversationPlanGateResponse(
      supabase,
      workspaceId,
      id
    );
    if (planGateResponse) {
      return planGateResponse;
    }

    await Conversation.updateOne(
      { _id: id },
      {
        $set: {
          rename: renameToSave,
          updatedAt: new Date(),
        },
      }
    );

    try {
      await Promise.all([
        invalidateConversationCache(workspaceId, id),
        invalidateRequestsForWorkspace(workspaceId),
      ]);
    } catch {
      // Non-blocking cache invalidation.
    }

    return NextResponse.json({ rename: renameToSave });
  } catch (error) {
    return errorMessageResponse(error, 500);
  }
}
