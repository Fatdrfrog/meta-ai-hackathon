import { createHash } from "node:crypto";
import { unwrapSettled } from "@icecore/shared/lib/value-utils";
import connectDB from "@/lib/mongoose";
import { isMissingOptionalCampaignLinkageColumnError } from "@/lib/campaign/campaign-history-store";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import { supabaseAdmin } from "@/lib/supabase/admin";
import CrossStoreOutbox from "@/models/cross-store-outbox";
import {
  dispatchConfirmedPaymentScenario,
  reconcilePendingConfirmedPayments,
  recordConfirmedPaymentScenarioFailure,
} from "@/lib/conversions/confirmed-payment-scenario";
import {
  deliverMetaConversion,
  reconcilePendingMetaConversions,
  recordMetaConversionPreparationFailure,
  type MetaConversionOutboxPayload,
} from "@/lib/conversions/meta-conversion-delivery";
import {
  GcpAiGatewayHttpError,
  publishRemoteLlmAnalyticsEvents,
} from "@/lib/ai/gcp-ai-gateway";
import {
  sendWhatsAppLlmFeedbackReasonPrompt,
  sendWhatsAppLlmHelpfulnessPrompt,
  upsertWhatsAppLlmAnswerReviewItem,
} from "@/lib/llm-analytics/whatsapp-feedback";
import { createServerLogger } from "@/lib/observability/server-logs";
import { resolveWhatsAppSendContext } from "@/lib/whatsapp/send-context";
import {
  buildLlmAnalyticsProductEvents,
  LLM_ANALYTICS_DEFAULT_BATCH_LIMIT,
  type LlmAnalyticsEvent,
  type LlmAnalyticsWarehouseEvent,
} from "@icecore/airi-runtime/llm-analytics";
import {
  parseWhatsAppRecipientTarget,
  type WhatsAppRecipientTarget,
} from "@icecore/shared/lib/whatsapp/contact-identities";
import {
  WHATSAPP_CAMPAIGN_MESSAGE_STATUS_PREDECESSORS,
  type WhatsAppCampaignMessageStatus,
} from "@icecore/shared/types/whatsapp-delivery";
import type { BulkCampaignDispatchExecutionSource } from "@icecore/scenario-contracts";
import type { CrossStoreOutboxDrainBatchResult } from "@icecore/temporal";
import type { DispatchWebhookEventInput } from "@/lib/webhooks";

export type CrossStoreOutboxOperation =
  | "whatsapp_referral.enrich"
  | "customer_webhooks.dispatch"
  | "campaign_messages.upsert_sent"
  | "campaign_messages.update_attempt"
  | "campaign_messages.update_status"
  | "llm_analytics.publish_events"
  | "meta_conversions.publish_event"
  | "conversion.confirmed_payment"
  | "whatsapp_llm_feedback.send_helpfulness_prompt"
  | "whatsapp_llm_feedback.send_reason_prompt";

type CrossStoreOutboxTarget =
  | "temporal"
  | "supabase"
  | "gcp_ai_gateway"
  | "whatsapp_cloud_api";

const crossStoreOutboxLogger = createServerLogger("cross-store-outbox");
const OUTBOX_PROCESS_CONCURRENCY = 10;

class CampaignMessageAttemptClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignMessageAttemptClosedError";
  }
}

type CampaignMessageSentPayload = {
  campaignId: string;
  snapshotOrdinal?: number;
  messageId: string;
  channel?: "whatsapp" | "telegram" | "email";
  recipient?: string;
  phone?: string;
  provider?: string;
  status?: string;
  attemptedAt?: string;
  scenarioId?: string;
  scenarioNodeId?: string;
  executionSource?: BulkCampaignDispatchExecutionSource;
};

type CampaignMessageAttemptPayload = {
  campaignId: string;
  snapshotOrdinal?: number;
  channel: "whatsapp" | "telegram" | "email";
  recipient?: string;
  phone?: string;
  provider?: string;
  status: "attempted" | "failed";
  attemptedAt?: string;
  failedAt?: string;
  providerError?: {
    code?: string | number | null;
    scope?: "recipient" | "provider" | string | null;
    message?: string | null;
  };
  insertIfMissing?: {
    messageId: string;
    workspaceId: string;
    recipientHash: string;
    scenarioId: string;
    scenarioNodeId: string;
    executionSource: BulkCampaignDispatchExecutionSource;
  };
};

type CampaignMessageStatusPayload = {
  messageId: string;
  updateData: Record<string, unknown>;
  realtime?: { workspaceId?: string | null; campaignId: string };
};

async function publishCampaignDeliveryChange(
  payload: CampaignMessageStatusPayload
) {
  if (!payload.realtime) return;
  let workspaceId = payload.realtime.workspaceId;
  if (!workspaceId) {
    const { data, error } = await supabaseAdmin
      .from("campaign_history")
      .select("workspace_id")
      .eq("id", payload.realtime.campaignId)
      .maybeSingle();
    if (error || !data?.workspace_id) {
      throw new Error("Campaign delivery realtime workspace is unavailable");
    }
    workspaceId = data.workspace_id;
  }
  const { triggerRealtimeEvent } = await import("@/lib/realtime/server");
  await triggerRealtimeEvent(
    `private-campaign-${payload.realtime.campaignId}`,
    "message-status-update",
    {
      workspaceId,
      messageId: payload.messageId,
      status: String(payload.updateData.status || "updated"),
      timestamp: String(payload.updateData.updated_at || ""),
    }
  );
}

type LlmAnalyticsPublishPayload = {
  events: LlmAnalyticsWarehouseEvent[];
};

type WhatsAppLlmPromptPayload = {
  workspaceId: string;
  conversationId: string;
  sourceId?: string;
  recipient: WhatsAppRecipientTarget;
  sourceMessageId: string | null;
};

type PreparedWhatsAppLlmPrompt = {
  accessToken: string;
  phoneNumberId: string;
  promptKind: "helpfulness" | "reason";
  recipient: WhatsAppRecipientTarget;
  sourceMessageId: string | null;
};

type PublishLlmAnalyticsEvents = (events: LlmAnalyticsEvent[]) => Promise<{
  accepted: number;
  published: number;
  skipped: boolean;
}>;

type OutboxOperationPayloadMap = {
  "whatsapp_referral.enrich": import("./whatsapp/referral-enrichment-store").WhatsAppReferralEnrichmentIntent;
  "customer_webhooks.dispatch": DispatchWebhookEventInput;
  "campaign_messages.upsert_sent": CampaignMessageSentPayload;
  "campaign_messages.update_attempt": CampaignMessageAttemptPayload;
  "campaign_messages.update_status": CampaignMessageStatusPayload;
  "llm_analytics.publish_events": LlmAnalyticsPublishPayload;
  "meta_conversions.publish_event": MetaConversionOutboxPayload;
  "conversion.confirmed_payment": { workspaceId: string; conversionId: string };
  "whatsapp_llm_feedback.send_helpfulness_prompt": WhatsAppLlmPromptPayload;
  "whatsapp_llm_feedback.send_reason_prompt": WhatsAppLlmPromptPayload;
};

type OutboxPayloadFor<TOperation extends CrossStoreOutboxOperation> =
  OutboxOperationPayloadMap[TOperation];

type PersistResult = {
  applied: boolean;
  queuedToOutbox: boolean;
  errorMessage?: string;
};

const OUTBOX_STALE_PROCESSING_MINUTES = 10;

function toErrorMessage(error: unknown, maxLength = 1000): string {
  const raw =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error || "Unknown error");
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, maxLength - 3)}...`;
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return Object.fromEntries(entries) as T;
}

function providerFailureColumns(
  providerError: CampaignMessageAttemptPayload["providerError"]
) {
  const POSTGRES_INTEGER_MIN = -2_147_483_648;
  const POSTGRES_INTEGER_MAX = 2_147_483_647;
  const rawCode = providerError?.code;
  const numericCode =
    typeof rawCode === "number" && Number.isSafeInteger(rawCode)
      ? rawCode
      : typeof rawCode === "string" && /^-?\d+$/.test(rawCode)
        ? Number(rawCode)
        : undefined;
  const storesNumericCode =
    numericCode !== undefined &&
    Number.isInteger(numericCode) &&
    numericCode >= POSTGRES_INTEGER_MIN &&
    numericCode <= POSTGRES_INTEGER_MAX;
  const failureReason =
    rawCode !== undefined && rawCode !== null && !storesNumericCode
      ? JSON.stringify({
          providerCode: String(rawCode),
          providerScope: providerError?.scope || null,
        })
      : providerError?.scope;
  const failureScope =
    providerError?.scope === "provider" ||
    providerError?.scope === "recipient" ||
    providerError?.scope === "unknown"
      ? providerError.scope
      : providerError
        ? "unknown"
        : undefined;

  return {
    error_code: storesNumericCode ? numericCode : undefined,
    failure_scope: failureScope,
    failure_reason: failureReason,
    error_message: providerError?.message,
  };
}

type CampaignMessageLogicalRow = {
  id?: string | null;
  status?: string | null;
  message_id?: string | null;
  provider?: string | null;
  channel?: string | null;
  recipient?: string | null;
  snapshot_ordinal?: number | null;
};

const CAMPAIGN_MESSAGE_LIFECYCLE_IDENTITY_SELECT =
  "id,status,message_id,provider,channel,recipient,snapshot_ordinal";

async function readCampaignMessageByLifecycleIdentity(params: {
  campaignId: string;
  channel: string;
  recipient: string;
  snapshotOrdinal?: number;
  operation: CrossStoreOutboxOperation | "campaign_messages.read_acceptance";
}): Promise<CampaignMessageLogicalRow | null> {
  let query = supabaseAdmin
    .from("campaign_messages")
    .select(CAMPAIGN_MESSAGE_LIFECYCLE_IDENTITY_SELECT)
    .eq("campaign_id", params.campaignId);
  const hasOrdinal = params.snapshotOrdinal !== undefined;
  if (
    hasOrdinal &&
    (!Number.isInteger(params.snapshotOrdinal) || params.snapshotOrdinal! < 0)
  ) {
    throw new Error(`[${params.operation}] snapshot ordinal is invalid`);
  }
  query = hasOrdinal
    ? query.eq("snapshot_ordinal", params.snapshotOrdinal!)
    : query.eq("channel", params.channel).eq("recipient", params.recipient);
  const { data, error } = await query.limit(hasOrdinal ? 1 : 2);
  if (error) {
    throw new Error(
      `[${params.operation}] logical lookup failed: ${error.message}`
    );
  }
  if (!Array.isArray(data)) {
    throw new Error(`[${params.operation}] logical lookup is malformed`);
  }
  if (!hasOrdinal && data.length > 1) {
    throw new Error(
      `[${params.operation}] legacy recipient identity is ambiguous`
    );
  }
  const row = (data[0] || null) as CampaignMessageLogicalRow | null;
  if (
    row &&
    (!row.id ||
      row.channel !== params.channel ||
      row.recipient !== params.recipient)
  ) {
    throw new Error(
      `[${params.operation}] dispatch item identity is inconsistent`
    );
  }
  return row;
}

/** Recover accepted provider IDs from the existing ledger/outbox when a receipt is missing. */
export async function findCampaignMessageAcceptance(params: {
  workspaceId: string;
  campaignId: string;
  channel: "whatsapp";
  recipient: string;
  snapshotOrdinal?: number;
  provider: "meta";
  pendingMessageId?: string;
}): Promise<{ messageId: string } | null> {
  const operation = "campaign_messages.read_acceptance";
  const { data: campaign, error: campaignError } = await supabaseAdmin
    .from("campaign_history")
    .select("id,workspace_id,channel,audience_fingerprint")
    .eq("id", params.campaignId)
    .eq("workspace_id", params.workspaceId)
    .maybeSingle();
  if (campaignError) {
    throw new Error(
      `[${operation}] campaign lookup failed: ${campaignError.message}`
    );
  }
  if (
    !campaign ||
    campaign.id !== params.campaignId ||
    campaign.workspace_id !== params.workspaceId ||
    campaign.channel !== params.channel
  ) {
    throw new Error(
      `[${operation}] workspace-scoped campaign is missing or malformed`
    );
  }

  const findOutboxAcceptance = async (): Promise<{
    messageId: string;
  } | null> => {
    await connectDB();
    const prefix = `campaign_messages.upsert_sent:${params.campaignId}:`;
    // Reuse the existing compound index. Bound both the result count and time:
    // a large retained campaign outbox may require a repair before sending resumes.
    const records = await CrossStoreOutbox.find({
      target: "supabase",
      operation: "campaign_messages.upsert_sent",
      dedupeKey: {
        $gte: prefix,
        $lt: `campaign_messages.upsert_sent:${params.campaignId};`,
      },
      "payload.campaignId": params.campaignId,
      ...(params.snapshotOrdinal !== undefined
        ? { "payload.snapshotOrdinal": params.snapshotOrdinal }
        : {
            "payload.channel": { $in: [params.channel, null] },
            $or: [
              { "payload.recipient": params.recipient },
              { "payload.phone": params.recipient },
            ],
          }),
    })
      .hint("target_1_operation_1_dedupeKey_1")
      .maxTimeMS(2_000)
      .select("payload")
      .limit(2)
      .lean<Array<{ payload?: CampaignMessageSentPayload }>>();
    if (records.length > 1)
      throw new Error(`[${operation}] ambiguous acceptance outbox`);
    const payload = records[0]?.payload;
    if (!records.length) return null;
    const messageId =
      typeof payload?.messageId === "string" ? payload.messageId.trim() : "";
    if (
      !payload ||
      payload.campaignId !== params.campaignId ||
      (payload.channel || "whatsapp") !== params.channel ||
      (payload.recipient || payload.phone) !== params.recipient ||
      payload.snapshotOrdinal !== params.snapshotOrdinal ||
      (payload.provider && payload.provider !== params.provider) ||
      !messageId ||
      messageId === params.pendingMessageId ||
      messageId.startsWith(`${params.campaignId}:snapshot:`) ||
      messageId.startsWith("campaign-delivery-task:")
    ) {
      throw new Error(`[${operation}] acceptance outbox identity is malformed`);
    }
    return { messageId };
  };

  // After the workspace check, the ledger row and the outbox are independent
  // reads, so they run at once. The outbox result, or its failure, is used only
  // where a check below consults it.
  const [rowRead, outboxRead] = await Promise.allSettled([
    readCampaignMessageByLifecycleIdentity({
      ...params,
      operation,
    }),
    findOutboxAcceptance(),
  ]);
  const row = unwrapSettled(rowRead);
  if (!row) {
    if (params.snapshotOrdinal !== undefined || campaign.audience_fingerprint) {
      throw new Error(`[${operation}] admitted dispatch item row not found`);
    }
    return unwrapSettled(outboxRead);
  }
  if (
    (params.snapshotOrdinal !== undefined &&
      row.snapshot_ordinal !== params.snapshotOrdinal) ||
    !hasCompatibleProvider(row, params.provider)
  ) {
    throw new Error(`[${operation}] dispatch item identity is inconsistent`);
  }

  const messageId =
    typeof row.message_id === "string" ? row.message_id.trim() : "";
  // Admission pre-seeds message_id; that identifier is replaced on acceptance.
  // A synchronous rejection retains it, while an asynchronous failed callback
  // retains the provider ID and must never turn into a new activity send.
  const isPlaceholder =
    messageId === `${params.campaignId}:snapshot:${row.snapshot_ordinal}` ||
    (Boolean(params.pendingMessageId) && messageId === params.pendingMessageId);
  if (
    !isPlaceholder &&
    (messageId.startsWith("campaign-delivery-task:") ||
      messageId.startsWith(`${params.campaignId}:snapshot:`))
  ) {
    throw new Error(`[${operation}] pending message identity is inconsistent`);
  }
  if (
    messageId &&
    !isPlaceholder &&
    isIdempotentSentState(row, {
      campaignId: params.campaignId,
      messageId,
      provider: params.provider,
    })
  ) {
    return { messageId };
  }
  if (
    ["pending", "attempted", "failed"].includes(String(row.status || "")) &&
    (row.message_id == null || isPlaceholder)
  ) {
    return unwrapSettled(outboxRead);
  }
  throw new Error(`[${operation}] provider acceptance state is malformed`);
}

async function readCampaignMessageByProviderMessageId(params: {
  messageId: string;
  operation: CrossStoreOutboxOperation;
}): Promise<CampaignMessageLogicalRow | null> {
  const { data, error } = await supabaseAdmin
    .from("campaign_messages")
    .select("id,status,message_id,provider")
    .eq("message_id", params.messageId)
    .eq("channel", "whatsapp")
    .maybeSingle();
  if (error) {
    throw new Error(
      `[${params.operation}] provider message lookup failed: ${error.message}`
    );
  }
  return data;
}

function pickCampaignPricingUpdate(updateData: Record<string, unknown>): Record<string, unknown> {
  const fields = ["estimated_cost_usd", "cost_coverage", "pricing_billable", "pricing_type", "pricing_category", "pricing_event_at", "cost_tariff_context"];
  return Object.fromEntries(fields.filter(field => updateData[field] !== undefined).map(field => [field, updateData[field]]));
}

async function updateCampaignMessageEstimatedCost(params: {
  messageId: string;
  pricingUpdate: Record<string, unknown>;
  updatedAt?: unknown;
}): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("campaign_messages")
    .update(
      compactObject({
        ...params.pricingUpdate,
        updated_at: params.updatedAt,
      })
    )
    .eq("message_id", params.messageId)
    .eq("channel", "whatsapp")
    .select("id")
    .maybeSingle();
  if (error) {
    throw new Error(
      `[campaign_messages.update_status] cost update failed: ${error.message}`
    );
  }
  if (!data?.id) {
    throw new Error(
      "[campaign_messages.update_status] campaign message row not found"
    );
  }
}

function hasCompatibleProvider(
  row: CampaignMessageLogicalRow,
  provider: string | undefined
): boolean {
  return !row.provider || !provider || row.provider === provider;
}

function isIdempotentSentState(
  row: CampaignMessageLogicalRow,
  payload: CampaignMessageSentPayload
): boolean {
  return (
    ["sent", "accepted", "delivered", "read", "failed"].includes(
      String(row.status || "")
    ) &&
    row.message_id === payload.messageId &&
    hasCompatibleProvider(row, payload.provider)
  );
}

function isDuplicateSupabaseWrite(
  error: { message?: string | null } | null | undefined
): boolean {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("duplicate") || message.includes("unique");
}

function campaignMessageDeliveryStatusFromUpdate(
  updateData: Record<string, unknown>
): WhatsAppCampaignMessageStatus | null {
  const rawStatus = String(updateData.status || "")
    .trim()
    .toLowerCase();
  const normalizedStatus = rawStatus === "played" ? "read" : rawStatus;
  if (normalizedStatus in WHATSAPP_CAMPAIGN_MESSAGE_STATUS_PREDECESSORS) {
    return normalizedStatus as WhatsAppCampaignMessageStatus;
  }
  if (updateData.read_at) return "read";
  if (updateData.delivered_at) return "delivered";
  if (updateData.failed_at) return "failed";
  return null;
}

function computeRetryDelayMs(attempt: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const seconds = Math.min(30 * 60, Math.max(15, 2 ** safeAttempt * 5));
  return seconds * 1000;
}

function targetForOperation(
  operation: CrossStoreOutboxOperation
): CrossStoreOutboxTarget {
  if (operation === "conversion.confirmed_payment") return "temporal";
  if (operation === "llm_analytics.publish_events") return "gcp_ai_gateway";
  if (
    isWhatsAppLlmPromptOperation(operation) ||
    operation === "meta_conversions.publish_event" ||
    operation === "whatsapp_referral.enrich"
  ) {
    return "whatsapp_cloud_api";
  }
  return "supabase";
}

type WhatsAppLlmPromptOperation = Extract<
  CrossStoreOutboxOperation,
  | "whatsapp_llm_feedback.send_helpfulness_prompt"
  | "whatsapp_llm_feedback.send_reason_prompt"
>;

function isWhatsAppLlmPromptOperation(
  operation: CrossStoreOutboxOperation
): operation is WhatsAppLlmPromptOperation {
  return (
    operation === "whatsapp_llm_feedback.send_helpfulness_prompt" ||
    operation === "whatsapp_llm_feedback.send_reason_prompt"
  );
}

function readRequiredBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
  operation: WhatsAppLlmPromptOperation
): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`[${operation}] ${field} is invalid`);
  }
  return normalized;
}

function normalizeWhatsAppLlmPromptPayload(
  operation: WhatsAppLlmPromptOperation,
  payload: unknown
): WhatsAppLlmPromptPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`[${operation}] payload is invalid`);
  }
  const candidate = payload as Partial<WhatsAppLlmPromptPayload>;
  const workspaceId = readRequiredBoundedString(
    candidate.workspaceId,
    "workspaceId",
    256,
    operation
  );
  const conversationId = readRequiredBoundedString(
    candidate.conversationId,
    "conversationId",
    256,
    operation
  );
  const sourceMessageId =
    operation === "whatsapp_llm_feedback.send_reason_prompt" &&
    candidate.sourceMessageId === null
      ? null
      : readRequiredBoundedString(
          candidate.sourceMessageId,
          "sourceMessageId",
          512,
          operation
        );
  const sourceId =
    typeof candidate.sourceId === "string" && candidate.sourceId.trim()
      ? readRequiredBoundedString(
          candidate.sourceId,
          "sourceId",
          256,
          operation
        )
      : undefined;
  const recipient = parseWhatsAppRecipientTarget(candidate.recipient);
  if (!recipient || recipient.value.length > 256) {
    throw new Error(`[${operation}] recipient is invalid`);
  }
  return {
    workspaceId,
    conversationId,
    ...(sourceId ? { sourceId } : {}),
    recipient,
    sourceMessageId,
  };
}

async function prepareWhatsAppLlmPrompt(
  operation: WhatsAppLlmPromptOperation,
  payload: unknown
): Promise<PreparedWhatsAppLlmPrompt> {
  const promptPayload = normalizeWhatsAppLlmPromptPayload(operation, payload);
  if (operation === "whatsapp_llm_feedback.send_helpfulness_prompt") {
    const reviewItem = await upsertWhatsAppLlmAnswerReviewItem({
      workspaceId: promptPayload.workspaceId,
      conversationId: promptPayload.conversationId,
      sourceMessageId: promptPayload.sourceMessageId,
    });
    if (!reviewItem.item) {
      throw new Error(
        "[whatsapp_llm_feedback.send_helpfulness_prompt] review item could not be persisted"
      );
    }
  }
  const sendContext = await resolveWhatsAppSendContext({
    workspaceId: promptPayload.workspaceId,
    sourceId: promptPayload.sourceId,
  });
  if (!sendContext?.phoneNumberId || !sendContext.accessToken) {
    throw new Error(
      "[whatsapp_llm_feedback.send_helpfulness_prompt] send context is unavailable"
    );
  }
  return {
    phoneNumberId: sendContext.phoneNumberId,
    accessToken: sendContext.accessToken,
    promptKind:
      operation === "whatsapp_llm_feedback.send_helpfulness_prompt"
        ? "helpfulness"
        : "reason",
    recipient: promptPayload.recipient,
    sourceMessageId: promptPayload.sourceMessageId,
  };
}

async function sendPreparedWhatsAppLlmPrompt(
  prompt: PreparedWhatsAppLlmPrompt
): Promise<void> {
  const { promptKind, ...providerPrompt } = prompt;
  if (promptKind === "helpfulness") {
    await sendWhatsAppLlmHelpfulnessPrompt(providerPrompt);
    return;
  }
  await sendWhatsAppLlmFeedbackReasonPrompt(providerPrompt);
}

async function executeOutboxOperation(
  operation: CrossStoreOutboxOperation,
  payload: OutboxPayloadFor<CrossStoreOutboxOperation>,
  options?: { publishLlmAnalyticsEvents?: PublishLlmAnalyticsEvents }
): Promise<void> {
  if (operation === "whatsapp_referral.enrich") {
    const { enrichStoredWhatsAppReferral } = await import(
      "./whatsapp/referral-enrichment-store"
    );
    await enrichStoredWhatsAppReferral(
      payload as OutboxPayloadFor<"whatsapp_referral.enrich">
    );
    return;
  }
  if (operation === "customer_webhooks.dispatch") {
    const { dispatchWebhookEvent } = await import("@/lib/webhooks");
    await dispatchWebhookEvent(payload as DispatchWebhookEventInput);
    return;
  }
  if (operation === "conversion.confirmed_payment") {
    await dispatchConfirmedPaymentScenario(
      payload as OutboxPayloadFor<"conversion.confirmed_payment">
    );
    return;
  }
  if (operation === "llm_analytics.publish_events") {
    const analyticsPayload = payload as LlmAnalyticsPublishPayload;
    if (
      !Array.isArray(analyticsPayload.events) ||
      analyticsPayload.events.length === 0 ||
      analyticsPayload.events.length > LLM_ANALYTICS_DEFAULT_BATCH_LIMIT
    ) {
      throw new Error(
        `[llm_analytics.publish_events] events must contain 1 to ${LLM_ANALYTICS_DEFAULT_BATCH_LIMIT} product facts`
      );
    }
    const response = await (
      options?.publishLlmAnalyticsEvents || publishRemoteLlmAnalyticsEvents
    )(analyticsPayload.events);
    if (
      response.skipped ||
      response.accepted !== analyticsPayload.events.length ||
      response.published !== analyticsPayload.events.length
    ) {
      throw new Error(
        "[llm_analytics.publish_events] gateway did not durably publish the complete batch"
      );
    }
    return;
  }

  if (isWhatsAppLlmPromptOperation(operation)) {
    await sendPreparedWhatsAppLlmPrompt(
      await prepareWhatsAppLlmPrompt(operation, payload)
    );
    return;
  }

  if (operation === "campaign_messages.upsert_sent") {
    const sentPayload = payload as CampaignMessageSentPayload;
    const channel = String(sentPayload.channel || "whatsapp");
    const recipient = String(
      sentPayload.recipient || sentPayload.phone || ""
    ).trim();

    if (!recipient) {
      throw new Error(
        "[campaign_messages.upsert_sent] recipient (or phone) is required"
      );
    }

    const attemptedAt = sentPayload.attemptedAt || new Date().toISOString();
    const current = await readCampaignMessageByLifecycleIdentity({
      campaignId: sentPayload.campaignId,
      channel,
      recipient,
      snapshotOrdinal: sentPayload.snapshotOrdinal,
      operation,
    });
    let preseeded: Record<string, unknown> | null = null;
    let preseededUpdateError: { message: string } | null = null;
    if (current?.id) {
      const updateResult = await supabaseAdmin
        .from("campaign_messages")
        .update({
          message_id: sentPayload.messageId,
          provider: sentPayload.provider || null,
          status: sentPayload.status || "sent",
          attempted_at: attemptedAt,
        })
        .eq("id", current.id)
        .in("status", ["pending", "attempted"])
        .select("id")
        .maybeSingle();
      preseeded = updateResult.data;
      preseededUpdateError = updateResult.error;
    }

    if (preseededUpdateError) {
      throw new Error(
        `[campaign_messages.upsert_sent] preseeded update failed: ${preseededUpdateError.message}`
      );
    }

    if (preseeded) {
      return;
    }

    const resolvedAfterUpdate = current
      ? await readCampaignMessageByLifecycleIdentity({
          campaignId: sentPayload.campaignId,
          channel,
          recipient,
          snapshotOrdinal: sentPayload.snapshotOrdinal,
          operation,
        })
      : null;
    if (resolvedAfterUpdate) {
      if (isIdempotentSentState(resolvedAfterUpdate, sentPayload)) {
        return;
      }
      if (
        resolvedAfterUpdate.message_id &&
        resolvedAfterUpdate.message_id !== sentPayload.messageId
      ) {
        throw new Error(
          "[campaign_messages.upsert_sent] provider message identity conflict"
        );
      }
      throw new Error(
        `[campaign_messages.upsert_sent] incompatible current status: ${resolvedAfterUpdate.status || "unknown"}`
      );
    }
    if (current) {
      throw new Error(
        "[campaign_messages.upsert_sent] dispatch item row disappeared during update"
      );
    }
    if (sentPayload.snapshotOrdinal !== undefined) {
      throw new Error(
        "[campaign_messages.upsert_sent] admitted dispatch item row not found"
      );
    }

    const { data: campaign, error: campaignError } = await supabaseAdmin
      .from("campaign_history")
      .select("audience_fingerprint")
      .eq("id", sentPayload.campaignId)
      .maybeSingle();
    if (campaignError) {
      throw new Error(
        `[campaign_messages.upsert_sent] campaign lookup failed: ${campaignError.message}`
      );
    }
    if (!campaign) {
      throw new Error(
        "[campaign_messages.upsert_sent] campaign history row not found"
      );
    }
    if (campaign.audience_fingerprint) {
      throw new Error(
        "[campaign_messages.upsert_sent] preseeded recipient row not found for admitted campaign"
      );
    }

    const baseInsertPayload = {
      campaign_id: sentPayload.campaignId,
      message_id: sentPayload.messageId,
      channel,
      recipient,
      provider: sentPayload.provider || null,
      phone: channel === "whatsapp" ? recipient : sentPayload.phone || null,
      status: sentPayload.status || "sent",
      attempted_at: attemptedAt,
    };
    const linkageInsertPayload = {
      ...baseInsertPayload,
      scenario_id: sentPayload.scenarioId || null,
      scenario_node_id: sentPayload.scenarioNodeId || null,
      execution_source: sentPayload.executionSource || null,
    };

    let { error: insertError } = await supabaseAdmin
      .from("campaign_messages")
      .insert(linkageInsertPayload);

    if (isMissingOptionalCampaignLinkageColumnError(insertError)) {
      ({ error: insertError } = await supabaseAdmin
        .from("campaign_messages")
        .insert(baseInsertPayload));
    }

    if (insertError) {
      if (isDuplicateSupabaseWrite(insertError)) {
        const raced = await readCampaignMessageByLifecycleIdentity({
          campaignId: sentPayload.campaignId,
          channel,
          recipient,
          operation,
        });
        if (raced && isIdempotentSentState(raced, sentPayload)) {
          return;
        }
        throw new Error(
          "[campaign_messages.upsert_sent] duplicate logical recipient has conflicting message identity"
        );
      }
      throw new Error(
        `[campaign_messages.upsert_sent] insert failed: ${insertError.message}`
      );
    }
    return;
  }

  if (operation === "campaign_messages.update_attempt") {
    const attemptPayload = payload as CampaignMessageAttemptPayload;
    const recipient = String(
      attemptPayload.recipient || attemptPayload.phone || ""
    ).trim();
    if (!recipient) {
      throw new Error(
        "[campaign_messages.update_attempt] recipient (or phone) is required"
      );
    }

    const attemptedAt = attemptPayload.attemptedAt || new Date().toISOString();
    const failedAt =
      attemptPayload.status === "failed"
        ? attemptPayload.failedAt || attemptedAt
        : undefined;
    const providerError = attemptPayload.providerError;
    const updateData = compactObject({
      provider: attemptPayload.provider || null,
      status: attemptPayload.status,
      attempted_at: attemptedAt,
      failed_at: failedAt,
      ...providerFailureColumns(providerError),
    });
    const current = await readCampaignMessageByLifecycleIdentity({
      campaignId: attemptPayload.campaignId,
      channel: attemptPayload.channel,
      recipient,
      snapshotOrdinal: attemptPayload.snapshotOrdinal,
      operation,
    });
    if (!current?.id) {
      if (attemptPayload.snapshotOrdinal !== undefined) {
        throw new CampaignMessageAttemptClosedError(
          "[campaign_messages.update_attempt] admitted dispatch item row not found"
        );
      }
      const insertIfMissing = attemptPayload.insertIfMissing;
      if (!insertIfMissing) {
        throw new Error(
          "[campaign_messages.update_attempt] no compatible recipient state found"
        );
      }
      const { data: campaign, error: campaignError } = await supabaseAdmin
        .from("campaign_history")
        .select(
          "audience_fingerprint,workspace_id,channel,scenario_id,scenario_node_id,execution_source"
        )
        .eq("id", attemptPayload.campaignId)
        .maybeSingle();
      if (campaignError) {
        throw new Error(
          `[campaign_messages.update_attempt] campaign lookup failed: ${campaignError.message}`
        );
      }
      if (!campaign) {
        throw new Error(
          "[campaign_messages.update_attempt] campaign history row not found"
        );
      }
      if (campaign.audience_fingerprint) {
        throw new CampaignMessageAttemptClosedError(
          "[campaign_messages.update_attempt] missing ordinal insert against a fingerprinted admitted campaign"
        );
      }
      if (
        campaign.workspace_id !== insertIfMissing.workspaceId ||
        campaign.channel !== attemptPayload.channel ||
        campaign.scenario_id !== insertIfMissing.scenarioId ||
        campaign.scenario_node_id !== insertIfMissing.scenarioNodeId ||
        campaign.execution_source !== insertIfMissing.executionSource
      ) {
        throw new CampaignMessageAttemptClosedError(
          "[campaign_messages.update_attempt] insertIfMissing linkage does not match campaign history"
        );
      }

      const insertPayload = compactObject({
        campaign_id: attemptPayload.campaignId,
        message_id: insertIfMissing.messageId,
        workspace_id: insertIfMissing.workspaceId,
        recipient_hash: insertIfMissing.recipientHash,
        channel: attemptPayload.channel,
        recipient,
        phone:
          attemptPayload.channel === "whatsapp"
            ? recipient
            : attemptPayload.phone || null,
        provider: attemptPayload.provider || null,
        status: attemptPayload.status,
        attempted_at: attemptedAt,
        failed_at: failedAt,
        scenario_id: insertIfMissing.scenarioId,
        scenario_node_id: insertIfMissing.scenarioNodeId,
        execution_source: insertIfMissing.executionSource,
        ...providerFailureColumns(providerError),
      });
      const { error: insertError } = await supabaseAdmin
        .from("campaign_messages")
        .insert(insertPayload);
      if (insertError) {
        if (isDuplicateSupabaseWrite(insertError)) {
          const raced = await readCampaignMessageByLifecycleIdentity({
            campaignId: attemptPayload.campaignId,
            channel: attemptPayload.channel,
            recipient,
            operation,
          });
          if (
            raced &&
            raced.message_id === insertIfMissing.messageId &&
            hasCompatibleProvider(raced, attemptPayload.provider)
          ) {
            return;
          }
          throw new CampaignMessageAttemptClosedError(
            "[campaign_messages.update_attempt] insertIfMissing race has a conflicting identity"
          );
        }
        throw new Error(
          `[campaign_messages.update_attempt] insert failed: ${insertError.message}`
        );
      }
      return;
    }
    let updateQuery = supabaseAdmin
      .from("campaign_messages")
      .update(updateData)
      .eq("id", current.id);
    updateQuery =
      attemptPayload.status === "attempted"
        ? updateQuery.eq("status", "pending")
        : updateQuery.in("status", ["pending", "attempted"]);
    const { data: updated, error: updateError } = await updateQuery
      .select("id")
      .maybeSingle();

    if (updateError) {
      throw new Error(
        `[campaign_messages.update_attempt] update failed: ${updateError.message}`
      );
    }
    if (!updated) {
      const refreshed = await readCampaignMessageByLifecycleIdentity({
        campaignId: attemptPayload.campaignId,
        channel: attemptPayload.channel,
        recipient,
        snapshotOrdinal: attemptPayload.snapshotOrdinal,
        operation,
      });
      const compatibleStatuses =
        attemptPayload.status === "attempted"
          ? ["attempted", "sent", "accepted", "delivered", "read", "failed"]
          : ["failed", "sent", "accepted", "delivered", "read"];
      const currentStatus = String(refreshed?.status || "");
      if (
        attemptPayload.status === "failed" &&
        ["sent", "accepted", "delivered", "read"].includes(currentStatus)
      ) {
        return;
      }
      if (
        refreshed &&
        compatibleStatuses.includes(currentStatus) &&
        hasCompatibleProvider(refreshed, attemptPayload.provider)
      ) {
        return;
      }
      throw new Error(
        "[campaign_messages.update_attempt] no compatible recipient state found"
      );
    }
    return;
  }

  if (operation === "campaign_messages.update_status") {
    const statusPayload = payload as CampaignMessageStatusPayload;
    const updateData = compactObject(statusPayload.updateData);
    const incomingStatus = campaignMessageDeliveryStatusFromUpdate(updateData);
    const estimatedCostUsd = updateData.estimated_cost_usd;
    if (
      estimatedCostUsd !== undefined &&
      estimatedCostUsd !== null &&
      (typeof estimatedCostUsd !== "number" ||
        !Number.isFinite(estimatedCostUsd) ||
        estimatedCostUsd < 0)
    ) {
      throw new Error(
        "[campaign_messages.update_status] estimated_cost_usd must be a non-negative number"
      );
    }

    if (!incomingStatus) {
      if (estimatedCostUsd === undefined) {
        return;
      }
      await updateCampaignMessageEstimatedCost({
        messageId: statusPayload.messageId,
        pricingUpdate: pickCampaignPricingUpdate(updateData),
        updatedAt: updateData.updated_at,
      });
      await publishCampaignDeliveryChange(statusPayload);
      return;
    }
    updateData.status = incomingStatus;
    const allowedCurrentStatuses = [
      ...WHATSAPP_CAMPAIGN_MESSAGE_STATUS_PREDECESSORS[incomingStatus],
    ];
    const { data: updatedMessage, error: updateError } = await supabaseAdmin
      .from("campaign_messages")
      .update(updateData)
      .eq("message_id", statusPayload.messageId)
      .eq("channel", "whatsapp")
      .in("status", allowedCurrentStatuses)
      .select("id")
      .maybeSingle();

    if (updateError) {
      throw new Error(
        `[campaign_messages.update_status] update failed: ${updateError.message}`
      );
    }
    if (!updatedMessage?.id) {
      const currentMessage = await readCampaignMessageByProviderMessageId({
        messageId: statusPayload.messageId,
        operation,
      });
      if (!currentMessage) {
        throw new Error(
          "[campaign_messages.update_status] campaign message row not found"
        );
      }

      if (estimatedCostUsd !== undefined) {
        await updateCampaignMessageEstimatedCost({
          messageId: statusPayload.messageId,
          pricingUpdate: pickCampaignPricingUpdate(updateData),
          updatedAt: updateData.updated_at,
        });
      }
    }
    // Replays must also invalidate: the SQL write may have succeeded before
    // publication failed. Repeated invalidations are safe to coalesce on the client.
    await publishCampaignDeliveryChange(statusPayload);
    return;
  }

  throw new Error(`Unsupported outbox operation: ${operation}`);
}

async function enqueueOutboxOperation<
  TOperation extends CrossStoreOutboxOperation,
>(
  operation: TOperation,
  dedupeKey: string,
  payload: OutboxPayloadFor<TOperation>,
  maxAttempts = 8
): Promise<void> {
  await connectDB();
  const now = new Date();
  const target = targetForOperation(operation);
  const createOrKeepPending = async () => {
    const outboxEntry = await CrossStoreOutbox.findOneAndUpdate(
      {
        target,
        operation,
        dedupeKey,
      },
      {
        $setOnInsert: {
          target,
          operation,
          dedupeKey,
          payload,
          status: "pending",
          attempts: 0,
          maxAttempts,
          nextRetryAt: now,
          processingStartedAt: null,
          completedAt: null,
          lastError: null,
        },
      },
      { upsert: true, new: true }
    );
    if (
      operation === "llm_analytics.publish_events" &&
      outboxEntry?.status === "failed"
    ) {
      await CrossStoreOutbox.updateOne(
        { _id: outboxEntry._id, status: "failed" },
        {
          $set: {
            status: "pending",
            attempts: 0,
            maxAttempts,
            nextRetryAt: now,
            processingStartedAt: null,
            completedAt: null,
            lastError: null,
          },
        }
      );
    }
  };

  try {
    await createOrKeepPending();
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) {
      throw error;
    }
    await createOrKeepPending();
  }
}

async function executeWithOutboxFallback<
  TOperation extends CrossStoreOutboxOperation,
>(params: {
  operation: TOperation;
  dedupeKey: string;
  payload: OutboxPayloadFor<TOperation>;
  maxAttempts?: number;
}): Promise<PersistResult> {
  try {
    await executeOutboxOperation(
      params.operation,
      params.payload as OutboxPayloadFor<CrossStoreOutboxOperation>
    );
    return { applied: true, queuedToOutbox: false };
  } catch (error) {
    if (error instanceof CampaignMessageAttemptClosedError) {
      throw error;
    }
    const message = toErrorMessage(error);
    if (error instanceof GcpAiGatewayHttpError && error.permanent) {
      return {
        applied: false,
        queuedToOutbox: false,
        errorMessage: message,
      };
    }
    try {
      await enqueueOutboxOperation(
        params.operation,
        params.dedupeKey,
        params.payload,
        params.maxAttempts || 8
      );
      return {
        applied: false,
        queuedToOutbox: true,
        errorMessage: message,
      };
    } catch (enqueueError) {
      return {
        applied: false,
        queuedToOutbox: false,
        errorMessage: `${message}; outbox enqueue failed: ${toErrorMessage(enqueueError)}`,
      };
    }
  }
}

export async function persistCampaignMessageSentWithOutbox(
  payload: CampaignMessageSentPayload
): Promise<PersistResult> {
  const normalizedPayload: CampaignMessageSentPayload = {
    ...payload,
    attemptedAt: payload.attemptedAt || new Date().toISOString(),
  };
  const recipient =
    normalizedPayload.recipient || normalizedPayload.phone || "";
  const channel = normalizedPayload.channel || "whatsapp";
  const lifecycleIdentity =
    normalizedPayload.snapshotOrdinal === undefined
      ? `${channel}:${recipient}`
      : `snapshot:${normalizedPayload.snapshotOrdinal}`;
  const dedupeKey = [
    "campaign_messages.upsert_sent",
    normalizedPayload.campaignId,
    normalizedPayload.messageId,
    lifecycleIdentity,
  ].join(":");

  return executeWithOutboxFallback({
    operation: "campaign_messages.upsert_sent",
    dedupeKey,
    payload: normalizedPayload,
    maxAttempts: 8,
  });
}

export async function persistCampaignMessageAttemptWithOutbox(
  payload: CampaignMessageAttemptPayload
): Promise<PersistResult> {
  const attemptedAt = payload.attemptedAt || new Date().toISOString();
  const normalizedPayload: CampaignMessageAttemptPayload = {
    ...payload,
    attemptedAt,
    failedAt:
      payload.status === "failed"
        ? payload.failedAt || attemptedAt
        : payload.failedAt,
  };
  const recipient =
    normalizedPayload.recipient || normalizedPayload.phone || "";
  const insertIdentity = normalizedPayload.insertIfMissing?.messageId;
  const lifecycleIdentity =
    insertIdentity ||
    (normalizedPayload.snapshotOrdinal === undefined
      ? `${normalizedPayload.channel}:${recipient}`
      : `snapshot:${normalizedPayload.snapshotOrdinal}`);
  const dedupeKey = [
    "campaign_messages.update_attempt",
    normalizedPayload.campaignId,
    lifecycleIdentity,
    normalizedPayload.status,
    attemptedAt,
  ].join(":");

  return executeWithOutboxFallback({
    operation: "campaign_messages.update_attempt",
    dedupeKey,
    payload: normalizedPayload,
    maxAttempts: 8,
  });
}

export async function persistCampaignMessageStatusWithOutbox(
  payload: CampaignMessageStatusPayload
): Promise<PersistResult> {
  const updateStatus = String(payload.updateData.status || "unknown");
  const updatedAt = String(payload.updateData.updated_at || "");
  const dedupeKey = [
    "campaign_messages.update_status",
    payload.messageId,
    updateStatus,
    updatedAt,
  ].join(":");

  return executeWithOutboxFallback({
    operation: "campaign_messages.update_status",
    dedupeKey,
    payload,
    maxAttempts: 8,
  });
}

export async function persistLlmAnalyticsEventsWithOutbox(
  events: LlmAnalyticsEvent[]
): Promise<PersistResult> {
  const productEvents = buildLlmAnalyticsProductEvents(events);
  if (productEvents.length === 0) {
    return { applied: true, queuedToOutbox: false };
  }

  const results: PersistResult[] = [];
  for (
    let offset = 0;
    offset < productEvents.length;
    offset += LLM_ANALYTICS_DEFAULT_BATCH_LIMIT
  ) {
    const batch = productEvents.slice(
      offset,
      offset + LLM_ANALYTICS_DEFAULT_BATCH_LIMIT
    );
    const eventIdentity = batch
      .map(event => event.event_id)
      .sort()
      .join("\u0000");
    const dedupeHash = createHash("sha256").update(eventIdentity).digest("hex");
    results.push(
      await executeWithOutboxFallback({
        operation: "llm_analytics.publish_events",
        dedupeKey: `llm_analytics.publish_events:${dedupeHash}`,
        payload: { events: batch },
        maxAttempts: 12,
      })
    );
  }

  const applied = results.every(result => result.applied);
  const durablyOwned = results.every(
    result => result.applied || result.queuedToOutbox
  );
  const errorMessages = [
    ...new Set(
      results
        .map(result => result.errorMessage)
        .filter((message): message is string => Boolean(message))
    ),
  ];
  return {
    applied,
    queuedToOutbox:
      !applied && durablyOwned && results.some(result => result.queuedToOutbox),
    ...(errorMessages.length > 0
      ? { errorMessage: errorMessages.join("; ") }
      : {}),
  };
}

export async function enqueueWhatsAppReferralEnrichmentWithOutbox(
  payload: OutboxPayloadFor<"whatsapp_referral.enrich">,
): Promise<void> {
  await enqueueOutboxOperation(
    "whatsapp_referral.enrich",
    `whatsapp-referral:${payload.workspaceId}:${payload.conversationId}:${payload.messageId}`,
    payload
  );
}

export async function enqueueMetaConversionWithOutbox(
  payload: MetaConversionOutboxPayload
): Promise<void> {
  await enqueueOutboxOperation(
    "meta_conversions.publish_event",
    `meta_conversions:${payload.workspaceId}:${payload.conversionId}`,
    payload
  );
}

export async function enqueueConfirmedPaymentWithOutbox(
  payload: OutboxPayloadFor<"conversion.confirmed_payment">
): Promise<void> {
  await enqueueOutboxOperation(
    "conversion.confirmed_payment",
    `confirmed-payment:${payload.workspaceId}:${payload.conversionId}`,
    payload
  );
}

export async function enqueueCustomerWebhookWithOutbox(
  payload: DispatchWebhookEventInput
): Promise<void> {
  const identity = JSON.stringify([
    payload.workspaceId,
    payload.eventType,
    payload.resourceId,
    payload.timestamp,
  ]);
  await enqueueOutboxOperation(
    "customer_webhooks.dispatch",
    `customer-webhook:${createHash("sha256").update(identity).digest("hex")}`,
    payload,
    8
  );
}

export async function enqueueWhatsAppLlmHelpfulnessPromptWithOutbox(params: {
  workspaceId: string;
  conversationId: string;
  sourceId?: string | null;
  recipient: WhatsAppRecipientTarget;
  sourceMessageId: string;
}): Promise<{ queuedToOutbox: true }> {
  return enqueueWhatsAppLlmPromptWithOutbox(
    "whatsapp_llm_feedback.send_helpfulness_prompt",
    params
  );
}

export async function enqueueWhatsAppLlmFeedbackReasonPromptWithOutbox(params: {
  workspaceId: string;
  conversationId: string;
  sourceId?: string | null;
  recipient: WhatsAppRecipientTarget | string;
  sourceMessageId: string | null;
}): Promise<{ queuedToOutbox: true }> {
  return enqueueWhatsAppLlmPromptWithOutbox(
    "whatsapp_llm_feedback.send_reason_prompt",
    params
  );
}

async function enqueueWhatsAppLlmPromptWithOutbox(
  operation: WhatsAppLlmPromptOperation,
  params: {
    workspaceId: string;
    conversationId: string;
    sourceId?: string | null;
    recipient: WhatsAppRecipientTarget | string;
    sourceMessageId: string | null;
  }
): Promise<{ queuedToOutbox: true }> {
  const payload = normalizeWhatsAppLlmPromptPayload(operation, params);
  const identity = JSON.stringify([
    payload.workspaceId,
    payload.conversationId,
    payload.sourceId || null,
    payload.recipient.kind,
    payload.recipient.value,
    payload.sourceMessageId,
  ]);
  const dedupeHash = createHash("sha256").update(identity).digest("hex");
  await enqueueOutboxOperation(
    operation,
    `${operation}:${dedupeHash}`,
    payload,
    12
  );
  return { queuedToOutbox: true };
}

async function recoverStaleProcessing(now: Date): Promise<number> {
  const staleCutoff = new Date(
    now.getTime() - OUTBOX_STALE_PROCESSING_MINUTES * 60_000
  );

  const result = await CrossStoreOutbox.updateMany(
    {
      status: "processing",
      processingStartedAt: { $ne: null, $lte: staleCutoff },
    },
    {
      $set: {
        status: "pending",
        processingStartedAt: null,
        nextRetryAt: now,
        lastError: "Recovered stale processing outbox operation",
      },
    }
  );

  return result.modifiedCount || 0;
}

export async function processCrossStoreOutboxBatch(params?: {
  deadlineAtMs?: number;
  limit?: number;
  onProgress?: (progress: { candidates: number; processed: number }) => void;
  publishLlmAnalyticsEvents?: PublishLlmAnalyticsEvents;
}): Promise<CrossStoreOutboxDrainBatchResult> {
  const now = new Date();
  const limit = Math.max(1, Math.min(200, Number(params?.limit || 200)));

  await connectDB();

  let customerWebhookIntentsAdmitted = 0;
  let customerWebhookIntentsSkipped = 0;
  let customerWebhookIntentsHasMore = false;
  try {
    const { reconcileCustomerWebhookIntents } = await import(
      "@/lib/customer-webhook-intents"
    );
    const recovery = await reconcileCustomerWebhookIntents({
      enqueue: enqueueCustomerWebhookWithOutbox,
      limit: Math.min(limit, 100),
      deadlineAtMs: Math.min(
        params?.deadlineAtMs || Infinity,
        Date.now() + 3_000
      ),
    });
    customerWebhookIntentsAdmitted = recovery.admitted;
    customerWebhookIntentsSkipped = recovery.skipped;
    customerWebhookIntentsHasMore = recovery.hasMore;
  } catch {
    crossStoreOutboxLogger.warn(
      "Customer webhook intent reconciliation will retry",
      {
        event: "customer_webhook.reconciliation_failed",
      }
    );
  }

  try {
    await reconcilePendingMetaConversions({
      enqueue: enqueueMetaConversionWithOutbox,
      limit,
      deadlineAtMs: params?.deadlineAtMs,
    });
  } catch {
    // Existing campaign/analytics work must drain even when the SQL sales ledger
    // is temporarily unavailable. Its pending rows remain durable for next time.
    crossStoreOutboxLogger.warn("Meta conversion reconciliation unavailable", {
      event: "meta_conversion.reconciliation_failed",
    });
  }

  try {
    await reconcilePendingConfirmedPayments({
      enqueue: enqueueConfirmedPaymentWithOutbox,
      limit,
      deadlineAtMs: params?.deadlineAtMs,
    });
  } catch {
    crossStoreOutboxLogger.warn(
      "Confirmed payment reconciliation unavailable",
      {
        event: "confirmed_payment.reconciliation_failed",
      }
    );
  }

  const recoveredStale = await recoverStaleProcessing(now);
  {
    const journeyStartedAt = Date.now();
    const { reconcileConversionCustomerEvents } = await import(
      "@/lib/conversions/customer-event-reconciliation"
    );
    const { admitCustomerBehaviorEvents } = await import(
      "@/lib/scenarios/behavior-runs"
    );
    const { dispatchDueBehaviorRuns } = await import(
      "@/lib/scenarios/behavior-runtime"
    );
    const { admitWebsiteCarts } = await import("@/lib/commerce/carts");
    const { drainWebsiteCommerceEvents } = await import(
      "@/lib/commerce/store-events"
    );
    // Give each phase a bounded share. Due journeys run first; their direct sales
    // check does not depend on projection catching up.
    for (const [index, drain] of [
      dispatchDueBehaviorRuns,
      reconcileConversionCustomerEvents,
      drainWebsiteCommerceEvents,
      admitWebsiteCarts,
      admitCustomerBehaviorEvents,
    ].entries()) {
      const deadlineAtMs = Math.min(
        params?.deadlineAtMs || Infinity,
        journeyStartedAt + (index + 1) * 3_000
      );
      if (Date.now() >= deadlineAtMs) continue;
      try {
        await drain({ limit: 25, deadlineAtMs });
      } catch {
        crossStoreOutboxLogger.warn("Customer journey drain will retry", {
          event: "customer_behavior.drain_failed",
          phase: index,
        });
      }
    }
  }

  // Reconciliation admits new pending entries after the batch started. Include
  // those entries in this pass rather than waiting for the next scheduled run.
  const eligibleAt = new Date();
  const candidates = await CrossStoreOutbox.find({
    status: "pending",
    nextRetryAt: { $lte: eligibleAt },
  })
    .sort({ nextRetryAt: 1, createdAt: 1 })
    .limit(limit)
    .select("_id")
    .lean<Array<{ _id?: unknown }>>();

  let claimed = 0;
  let completed = 0;
  let retried = 0;
  let failed = 0;
  let skippedUnsupported = 0;

  const processCandidate = async (candidate: { _id?: unknown }) => {
    const id = String(candidate._id || "");
    if (!id) return;

    const claimedDoc = await CrossStoreOutbox.findOneAndUpdate(
      {
        _id: id,
        status: "pending",
        nextRetryAt: { $lte: eligibleAt },
      },
      {
        $set: {
          status: "processing",
          processingStartedAt: now,
        },
        $inc: { attempts: 1 },
      },
      { new: true }
    ).lean<{
      _id?: unknown;
      operation?: string;
      payload?: unknown;
      attempts?: number;
      maxAttempts?: number;
    } | null>();

    if (!claimedDoc) return;
    claimed += 1;

    const operation = String(
      claimedDoc.operation || ""
    ) as CrossStoreOutboxOperation;
    const payload =
      claimedDoc.payload as OutboxPayloadFor<CrossStoreOutboxOperation>;
    const attempts = Math.max(1, Number(claimedDoc.attempts || 1));
    const maxAttempts = Math.max(1, Number(claimedDoc.maxAttempts || 8));
    const isAtMostOncePrompt = isWhatsAppLlmPromptOperation(operation);
    let promptDeliveryStarted = false;
    let paymentSignalAccepted = false;

    try {
      if (operation === "meta_conversions.publish_event") {
        // The canonical SQL claim is committed BEFORE the HTTP request. Mongo
        // lease recovery therefore cannot resend an ambiguous Meta event.
        const outcome = await deliverMetaConversion(
          payload as MetaConversionOutboxPayload
        );
        const terminalStatus =
          outcome.status === "delivery_unknown"
            ? "delivery_unknown"
            : outcome.status === "rejected"
              ? "failed"
              : "completed";
        const saved = await CrossStoreOutbox.updateOne(
          { _id: id, status: "processing" },
          {
            $set: {
              status: terminalStatus,
              completedAt: terminalStatus === "completed" ? new Date() : null,
              processingStartedAt: null,
              lastError:
                terminalStatus === "completed"
                  ? null
                  : `meta_conversion.${outcome.status}`,
            },
          }
        );
        if (saved.modifiedCount !== 1) {
          throw new Error("Meta conversion outbox completion ownership lost");
        }
        if (terminalStatus === "completed") completed += 1;
        else failed += 1;
        return;
      }

      if (
        operation !== "campaign_messages.upsert_sent" &&
        operation !== "campaign_messages.update_attempt" &&
        operation !== "campaign_messages.update_status" &&
        operation !== "llm_analytics.publish_events" &&
        operation !== "conversion.confirmed_payment" &&
        operation !== "whatsapp_referral.enrich" &&
        operation !== "customer_webhooks.dispatch" &&
        operation !== "whatsapp_llm_feedback.send_helpfulness_prompt" &&
        operation !== "whatsapp_llm_feedback.send_reason_prompt"
      ) {
        skippedUnsupported += 1;
        throw new Error(`Unsupported outbox operation: ${operation}`);
      }

      const preparedPrompt = isAtMostOncePrompt
        ? await prepareWhatsAppLlmPrompt(operation, payload)
        : null;

      if (operation === "customer_webhooks.dispatch") {
        const event = payload as DispatchWebhookEventInput;
        if (!Array.isArray(event.subscriptionIds)) {
          const { snapshotWebhookSubscriptionIds } = await import(
            "@/lib/webhooks"
          );
          const subscriptionIds = await snapshotWebhookSubscriptionIds(event);
          const frozen = await CrossStoreOutbox.updateOne(
            { _id: id, status: "processing" },
            { $set: { "payload.subscriptionIds": subscriptionIds } }
          );
          if (frozen.modifiedCount !== 1)
            throw new Error("Webhook subscription snapshot ownership lost");
          event.subscriptionIds = subscriptionIds;
        }
      }

      if (preparedPrompt) {
        const transition = await CrossStoreOutbox.updateOne(
          { _id: id, status: "processing" },
          {
            $set: {
              status: "delivery_unknown",
              processingStartedAt: null,
              lastError: null,
            },
          }
        );
        if (transition.modifiedCount !== 1) {
          throw new Error(
            "WhatsApp prompt delivery ownership was lost before provider send"
          );
        }
        promptDeliveryStarted = true;
      }

      if (preparedPrompt) {
        await sendPreparedWhatsAppLlmPrompt(preparedPrompt);
      } else {
        await executeOutboxOperation(
          operation,
          payload as OutboxPayloadFor<CrossStoreOutboxOperation>,
          { publishLlmAnalyticsEvents: params?.publishLlmAnalyticsEvents }
        );
        paymentSignalAccepted = operation === "conversion.confirmed_payment";
      }

      const completion = await CrossStoreOutbox.updateOne(
        {
          _id: id,
          status: isAtMostOncePrompt ? "delivery_unknown" : "processing",
        },
        {
          $set: {
            status: "completed",
            completedAt: new Date(),
            processingStartedAt: null,
            lastError: null,
          },
        }
      );
      if (completion.modifiedCount !== 1) {
        throw new Error(
          isAtMostOncePrompt
            ? "WhatsApp prompt completion ownership was lost after provider send"
            : "Outbox completion ownership was lost"
        );
      }
      completed += 1;
    } catch (error) {
      const errorMessage = toErrorMessage(error);

      if (isAtMostOncePrompt && promptDeliveryStarted) {
        await CrossStoreOutbox.updateOne(
          { _id: id, status: "delivery_unknown" },
          {
            $set: {
              processingStartedAt: null,
              lastError: errorMessage,
            },
          }
        );
        failed += 1;
        return;
      }

      if (
        attempts >= maxAttempts ||
        (error instanceof GcpAiGatewayHttpError && error.permanent)
      ) {
        if (
          operation === "conversion.confirmed_payment" &&
          !paymentSignalAccepted
        ) {
          await recordConfirmedPaymentScenarioFailure({
            ...(payload as OutboxPayloadFor<"conversion.confirmed_payment">),
            reason: "dispatch_retries_exhausted",
          });
        }
        if (operation === "meta_conversions.publish_event") {
          await recordMetaConversionPreparationFailure(
            payload as MetaConversionOutboxPayload
          );
        }
        await CrossStoreOutbox.updateOne(
          { _id: id, status: "processing" },
          {
            $set: {
              status: "failed",
              processingStartedAt: null,
              lastError: errorMessage,
            },
          }
        );
        failed += 1;
      } else {
        const retryAt = new Date(now.getTime() + computeRetryDelayMs(attempts));
        await CrossStoreOutbox.updateOne(
          { _id: id, status: "processing" },
          {
            $set: {
              status: "pending",
              processingStartedAt: null,
              nextRetryAt: retryAt,
              lastError: errorMessage,
            },
          }
        );
        retried += 1;
      }
    }
  };

  for (
    let index = 0;
    index < candidates.length;
    index += OUTBOX_PROCESS_CONCURRENCY
  ) {
    if (params?.deadlineAtMs && Date.now() >= params.deadlineAtMs) break;
    params?.onProgress?.({ candidates: candidates.length, processed: index });
    await Promise.all(
      candidates
        .slice(index, index + OUTBOX_PROCESS_CONCURRENCY)
        .map(processCandidate)
    );
    params?.onProgress?.({
      candidates: candidates.length,
      processed: Math.min(
        index + OUTBOX_PROCESS_CONCURRENCY,
        candidates.length
      ),
    });
  }

  const analyticsBacklog = await CrossStoreOutbox.countDocuments({
    target: "gcp_ai_gateway",
    operation: "llm_analytics.publish_events",
    status: { $in: ["pending", "processing"] },
  });
  const analyticsFailed = await CrossStoreOutbox.countDocuments({
    target: "gcp_ai_gateway",
    operation: "llm_analytics.publish_events",
    status: "failed",
  });
  crossStoreOutboxLogger.info("Cross-store outbox batch completed", {
    event: "cross_store_outbox.batch_completed",
    claimed,
    completed,
    retried,
    failed,
    analyticsBacklog,
    analyticsFailed,
    customerWebhookIntentsAdmitted,
    customerWebhookIntentsSkipped,
    customerWebhookIntentsHasMore,
  });

  return {
    recoveredStale,
    claimed,
    completed,
    retried,
    failed,
    skippedUnsupported,
    analyticsBacklog,
    analyticsFailed,
    customerWebhookIntentsAdmitted,
    customerWebhookIntentsSkipped,
    customerWebhookIntentsHasMore,
  };
}
