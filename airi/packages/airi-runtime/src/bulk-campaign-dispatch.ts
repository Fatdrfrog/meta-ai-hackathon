import {
  buildBulkCampaignDispatchLogicalRecipientKey,
  type BulkCampaignDispatchBeginResult,
  type BulkCampaignDispatchBatchResult,
  type BulkCampaignDispatchChannel,
  type BulkCampaignDispatchFinalizeInput,
  type BulkCampaignDispatchItem,
  type BulkCampaignDispatchLifecycleFinalizeInput,
  type BulkCampaignDispatchProgressInput,
  type BulkCampaignDispatchSendResult,
} from "@icecore/temporal";
import { readIntegerEnv } from "@icecore/shared/lib/env";
import { META_THROUGHPUT_ERROR_CODE } from "@icecore/shared/lib/meta/message-failure-scope";
import { buildCampaignCallbackData } from "@icecore/shared/lib/whatsapp/campaign-callback-data";
import { buildCampaignContactDeliveryKey } from "@icecore/shared/lib/whatsapp/campaign-contact-key";
import { getWABASendingReadiness } from "@icecore/whatsapp/sendingReadiness";
import {
  claimBulkDispatchActivityIntent,
  clearBulkDispatchActivityIntent,
  findBulkDispatchActivityDedupe,
  findBulkDispatchActivityState,
  recordBulkDispatchActivityDedupe,
} from "./bulk-dispatch-activity-dedupe";
import {
  createBatchScopedWhatsAppSendingReadinessResolver,
  createBatchScopedWhatsAppSendContextResolver,
  resolveBulkCampaignWhatsAppSendContext,
  type ResolveBulkCampaignWhatsAppSendContext,
  type ResolveBulkCampaignWhatsAppSendingReadiness,
} from "./bulk-campaign-whatsapp-send-context";
import { airiWorkerLogger } from "./logging";
import { createWebRequire, readDefaultExport } from "./internal/module-interop";

const requireWeb = createWebRequire(import.meta.url);
const connectDB = readDefaultExport<() => Promise<unknown>>(
  requireWeb("../../../apps/web/src/lib/mongoose"),
);
const {
  renderCampaignEmail,
  sendCampaignTransportBatch,
  sendCampaignTransportSingle,
} = requireWeb("../../../apps/web/src/lib/campaign/campaign-transport") as {
  renderCampaignEmail: (params: {
    templateKey?: string | null;
    templateModel: Record<string, unknown>;
    subjectOverride?: string | null;
    emailContent?: unknown;
  }) => Promise<{
    subject: string;
    html: string;
    text: string;
  }>;
  sendCampaignTransportBatch: (request: Record<string, unknown>) => Promise<{
    success: boolean;
    error?: string;
    results: Array<{
      success: boolean;
      messageId?: string;
      acceptedAt?: string;
      providerMessageStatus?: string;
      error?: string;
      provider?: string;
      providerCode?: string;
      failureScope?: "provider" | "recipient" | "unknown";
      recipient?: string;
    }>;
  }>;
  sendCampaignTransportSingle: (request: Record<string, unknown>) => Promise<{
    success: boolean;
    messageId?: string;
    acceptedAt?: string;
    providerMessageStatus?: string;
    error?: string;
    provider?: string;
    providerCode?: string;
    failureScope?: "provider" | "recipient" | "unknown";
    providerRequestAttempted?: true;
    providerAcceptanceUnknown?: true;
  }>;
};
const {
  findCampaignMessageAcceptance,
  persistCampaignMessageAttemptWithOutbox,
  persistCampaignMessageSentWithOutbox,
} = requireWeb("../../../apps/web/src/lib/cross-store-outbox") as {
  findCampaignMessageAcceptance: (params: {
    workspaceId: string;
    campaignId: string;
    channel: "whatsapp";
    recipient: string;
    snapshotOrdinal?: number;
    provider: "meta";
  }) => Promise<{ messageId: string } | null>;
  persistCampaignMessageAttemptWithOutbox: (
    payload: Record<string, unknown>,
  ) => Promise<{
    applied: boolean;
    queuedToOutbox: boolean;
    errorMessage?: string;
  }>;
  persistCampaignMessageSentWithOutbox: (
    payload: Record<string, unknown>,
  ) => Promise<{
    applied: boolean;
    queuedToOutbox: boolean;
    errorMessage?: string;
  }>;
};
const {
  persistCampaignEmailConversationMessage,
  persistCampaignWhatsAppConversationMessage,
} = requireWeb(
  "../../../apps/web/src/lib/campaign/campaign-conversation-persistence",
) as {
  persistCampaignEmailConversationMessage: (
    payload: Record<string, unknown>,
  ) => Promise<{
    persisted: boolean;
    conversationId?: string;
    messageId?: string;
    created?: boolean;
    reason?: string;
  }>;
  persistCampaignWhatsAppConversationMessage: (
    payload: Record<string, unknown> & {
      lookupCache?: CampaignConversationLookupCache;
      awaitRealtime?: boolean;
    },
  ) => Promise<{
    persisted: boolean;
    conversationId?: string;
    messageId?: string;
    created?: boolean;
    reason?: string;
  }>;
};
const { reconcileLegacyCampaignSendTotals } = requireWeb(
  "../../../apps/web/src/lib/campaign/campaign-stats",
) as {
  reconcileLegacyCampaignSendTotals: (params: {
    workspaceId: string;
    campaignId: string;
    totals: { successfulSends: number; failedSends: number };
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
};
const { classifyBulkCampaignProviderCircuit } = requireWeb(
  "../../../apps/web/src/lib/campaign/bulk-campaign-safety",
) as {
  classifyBulkCampaignProviderCircuit: (params: {
    batchStatus: "completed" | "incomplete";
    results: BulkCampaignDispatchSendResult[];
  }) => BulkCampaignDispatchBatchResult["providerCircuit"];
};
const {
  beginCampaignDispatch,
  finalizeCampaignDispatch,
  getCampaignDispatchProviderCircuit,
  reconcileCampaignDispatchCancellation,
  updateCampaignDispatchProgress,
} = requireWeb("../../../apps/web/src/lib/campaign/campaign-history-store") as {
  getCampaignDispatchProviderCircuit: (params: {
    supabase: unknown;
    workspaceId: string;
    campaignId: string;
  }) => Promise<
    NonNullable<BulkCampaignDispatchBatchResult["providerCircuit"]>
  >;
  beginCampaignDispatch: (params: {
    supabase: unknown;
    campaignId: string;
    expectedWorkflowId: string;
  }) => Promise<BulkCampaignDispatchBeginResult>;
  reconcileCampaignDispatchCancellation: (params: {
    supabase: unknown;
    workspaceId: string;
    campaignId: string;
    processedCount: number;
    acceptedCount: number;
    failedCount: number;
    attemptedCount: number;
    notAttemptedCount: number;
    stopReason?: string | null;
    providerCircuit?: {
      state: "open" | "closed";
      provider?: string | null;
      code?: string | number | null;
    };
  }) => Promise<{
    outcome:
      | "cancelled"
      | "already_cancelled"
      | "already_terminal"
      | "not_cancellable"
      | "not_found";
    status: string | null;
  }>;
  finalizeCampaignDispatch: (
    params: BulkCampaignDispatchLifecycleFinalizeInput & { supabase: unknown },
  ) => Promise<boolean>;
  updateCampaignDispatchProgress: (
    params: BulkCampaignDispatchProgressInput & { supabase: unknown },
  ) => Promise<boolean>;
};
const { resolveFreshWhatsAppSendContext } = requireWeb(
  "../../../apps/web/src/lib/whatsapp/send-context",
) as {
  resolveFreshWhatsAppSendContext: ResolveBulkCampaignWhatsAppSendContext;
};
const { fetchAndValidateTelegramSource } = requireWeb(
  "../../../apps/web/src/lib/telegram/validate-source",
) as {
  fetchAndValidateTelegramSource: (sourceId: string) => Promise<{
    valid: boolean;
    error?: string;
    source?: {
      workspace_id: string;
    };
    /** Decrypted from the source's stored credentials. */
    botToken?: string;
  }>;
};
const { markTelegramSubscriberSendResult } = requireWeb(
  "../../../apps/web/src/lib/telegram/subscribers",
) as {
  markTelegramSubscriberSendResult: (params: {
    workspaceId: string;
    sourceId?: string | null;
    chatId?: string | null;
    success: boolean;
    error?: string | null;
  }) => Promise<void>;
};
const {
  COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
  ensureCompanyConversationCapacity,
} = requireWeb("../../../apps/web/src/lib/limits/company-limits") as {
  COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE: string;
  ensureCompanyConversationCapacity: (
    supabase: unknown,
    workspaceId: string,
  ) => Promise<{ allowed: boolean }>;
};
const { supabaseAdmin } = requireWeb(
  "../../../apps/web/src/lib/supabase/admin",
) as {
  supabaseAdmin: unknown;
};

/** Limits concurrent sends per batch to reduce Meta 429 bursts and DB races. */
const DISPATCH_CONCURRENCY = 3;

/** Author and template lookups are identical for every item of one batch. */
type CampaignConversationLookupCache = {
  authors: Map<string, Promise<unknown>>;
  templateComponents: Map<string, Promise<unknown>>;
};

export type BulkCampaignDispatchActivityContext = {
  /** Temporal activityId is unique per batch invocation; keys are `${prefix}:${indexInBatch}`. */
  activityDedupePrefix: string;
  /** For wide events + correlating worker logs with Temporal UI / history. */
  temporalWorkflowId?: string;
  temporalRunId?: string;
  temporalActivityId?: string;
  /** Explicit v3 ledger boundary; never infer from item.campaignId. */
  lifecycleManaged?: boolean;
  campaignId?: string;
};

function readWorkerDeploymentMeta(): {
  nodeEnv: string;
  kRevision: string | null;
  gitSha: string | null;
} {
  return {
    nodeEnv: process.env.NODE_ENV || "development",
    kRevision: process.env.K_REVISION?.trim() || null,
    gitSha: process.env.GIT_SHA?.trim() || null,
  };
}

function temporalContextFields(
  context: BulkCampaignDispatchActivityContext | undefined,
): Record<string, string | undefined> {
  if (!context) {
    return {};
  }
  return {
    ...(context.temporalWorkflowId && {
      temporalWorkflowId: context.temporalWorkflowId,
    }),
    ...(context.temporalRunId && { temporalRunId: context.temporalRunId }),
    ...(context.temporalActivityId && {
      temporalActivityId: context.temporalActivityId,
    }),
  };
}

/** High-cardinality business + routing fields for bulk dispatch (no secrets). */
function itemDispatchLogFields(
  item: BulkCampaignDispatchItem,
  batchIndex: number,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    batchIndex,
    workspaceId: item.workspaceId,
    campaignId: item.campaignId ?? null,
    channel: item.channel,
    executionSource: item.executionSource ?? null,
    scenarioId: item.scenarioId ?? null,
    scenarioNodeId: item.scenarioNodeId ?? null,
  };

  if (item.channel === "whatsapp") {
    return {
      ...base,
      sourceId: item.sourceId ?? null,
      phoneNumberId: item.phoneNumberId,
      whatsappMessageType:
        item.whatsappMessageType === "service_text"
          ? "service_text"
          : "template",
      ...(item.whatsappMessageType === "service_text"
        ? {
            serviceWindowExpiresAt: item.serviceWindowExpiresAt,
            messageLength: item.messageText.length,
          }
        : {
            templateName: item.templateName,
            languageCode: item.languageCode ?? null,
            templateCategory: item.templateCategory ?? null,
          }),
      recipientPhone: item.recipient.phone,
    };
  }

  if (item.channel === "telegram") {
    return {
      ...base,
      sourceId: item.sourceId ?? null,
      recipientChatId: item.recipient.chatId,
    };
  }

  return {
    ...base,
    recipientEmail: item.recipient.email,
    templateKey: item.templateKey ?? null,
    emailContentFormat: item.emailContent?.format ?? null,
  };
}

/**
 * Ceiling for one batch's concurrent sends. A send takes well over a second
 * (several sequential cross-region round trips before the provider POST), so
 * 25 slots stay below Meta's default 80 messages/s per phone number unless
 * several large campaigns share one number at once. The batch plan's
 * throughput does not reach this activity, so this bound is the only guard.
 */
export const MAX_BULK_CAMPAIGN_DISPATCH_CONCURRENCY = 25;

/** Concurrent sends per batch; the owner raises it through the worker env. */
export function resolveBulkCampaignDispatchConcurrency(): number {
  return readIntegerEnv(
    "BULK_CAMPAIGN_DISPATCH_CONCURRENCY",
    DISPATCH_CONCURRENCY,
    { min: 1, max: MAX_BULK_CAMPAIGN_DISPATCH_CONCURRENCY },
  );
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let hasFatalError = false;
  let fatalError: unknown;
  async function worker() {
    while (!hasFatalError) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await mapper(items[i], i);
      } catch (error) {
        if (!hasFatalError) {
          hasFatalError = true;
          fatalError = error;
        }
        return;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  if (hasFatalError) {
    throw fatalError;
  }
  return results;
}

async function persistSentWithRetries(params: {
  campaignId: string;
  snapshotOrdinal?: number;
  messageId: string;
  channel: BulkCampaignDispatchChannel;
  recipient: string;
  phone?: string;
  attemptedAt?: string;
  scenarioId?: string;
  scenarioNodeId?: string;
  executionSource?: string;
}): Promise<{
  applied: boolean;
  queuedToOutbox: boolean;
  errorMessage?: string;
}> {
  let last: {
    applied: boolean;
    queuedToOutbox: boolean;
    errorMessage?: string;
  } = { applied: false, queuedToOutbox: false };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      last = await persistCampaignMessageSentWithOutbox({
        campaignId: params.campaignId,
        snapshotOrdinal: params.snapshotOrdinal,
        messageId: params.messageId,
        channel: params.channel,
        recipient: params.recipient,
        phone: params.phone,
        attemptedAt: params.attemptedAt,
        provider:
          params.channel === "whatsapp"
            ? "meta"
            : params.channel === "telegram"
              ? "telegram"
              : "postmark",
        status: "sent",
        scenarioId: params.scenarioId,
        scenarioNodeId: params.scenarioNodeId,
        executionSource: params.executionSource as
          | "scenario_schedule"
          | "scenario_run_now"
          | "ad_hoc"
          | undefined,
      });
    } catch (error) {
      last = {
        applied: false,
        queuedToOutbox: false,
        errorMessage: normalizeErrorMessage(error),
      };
    }

    if (last.applied || last.queuedToOutbox) {
      return last;
    }
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
  return last;
}

type CampaignMessagePersistResult = {
  applied: boolean;
  queuedToOutbox: boolean;
  errorMessage?: string;
};

class BulkCampaignLifecyclePersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BulkCampaignLifecyclePersistenceError";
  }
}

function providerForChannel(
  channel: BulkCampaignDispatchChannel,
): "meta" | "telegram" | "postmark" {
  return channel === "whatsapp"
    ? "meta"
    : channel === "telegram"
      ? "telegram"
      : "postmark";
}

function lifecyclePersistenceIdentity(params: {
  item: BulkCampaignDispatchItem;
  context: BulkCampaignDispatchActivityContext | undefined;
}): {
  campaignId: string;
  recipient: string;
  snapshotOrdinal?: number;
} | null {
  if (params.context?.lifecycleManaged !== true) return null;
  const campaignId = params.context.campaignId?.trim();
  if (!campaignId || params.item.campaignId !== campaignId) {
    throw new Error(
      "Lifecycle-managed bulk item does not match the activity campaign",
    );
  }
  const recipient = buildBulkCampaignDispatchLogicalRecipientKey(
    params.item,
  )?.trim();
  if (!recipient) {
    throw new Error("Lifecycle-managed bulk item has no logical recipient key");
  }
  const snapshotOrdinal = params.item.snapshotOrdinal;
  if (
    snapshotOrdinal !== undefined &&
    (!Number.isInteger(snapshotOrdinal) || snapshotOrdinal < 0)
  ) {
    throw new Error(
      "Lifecycle-managed bulk item has an invalid snapshot ordinal",
    );
  }
  return { campaignId, recipient, snapshotOrdinal };
}

async function persistLifecycleAttemptWithRetries(params: {
  item: BulkCampaignDispatchItem;
  context: BulkCampaignDispatchActivityContext | undefined;
  status: "attempted" | "failed";
  attemptedAt: string;
  provider?: string;
  providerCode?: string;
  failureScope?: "provider" | "recipient" | "unknown";
  error?: string;
}): Promise<void> {
  const identity = lifecyclePersistenceIdentity({
    item: params.item,
    context: params.context,
  });
  if (!identity) return;

  let last: CampaignMessagePersistResult = {
    applied: false,
    queuedToOutbox: false,
  };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      last = await persistCampaignMessageAttemptWithOutbox({
        campaignId: identity.campaignId,
        snapshotOrdinal: identity.snapshotOrdinal,
        channel: params.item.channel,
        recipient: identity.recipient,
        phone:
          params.item.channel === "whatsapp" ? identity.recipient : undefined,
        provider: params.provider || providerForChannel(params.item.channel),
        status: params.status,
        attemptedAt: params.attemptedAt,
        ...(params.status === "failed"
          ? {
              failedAt: new Date().toISOString(),
              providerError: {
                code: params.providerCode,
                scope: params.failureScope || "unknown",
                message: params.error,
              },
            }
          : {}),
      });
    } catch (error) {
      last = {
        applied: false,
        queuedToOutbox: false,
        errorMessage: normalizeErrorMessage(error),
      };
    }
    if (last.applied || last.queuedToOutbox) return;
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }

  throw new BulkCampaignLifecyclePersistenceError(
    last.errorMessage ||
      `Unable to persist lifecycle ${params.status} recipient state`,
  );
}

/**
 * Meta rejects a 130429 request outright, so the same recipient can be sent
 * again. Waits before each resend; jitter spreads the slots apart.
 */
const DEFAULT_THROUGHPUT_BACKOFF_MS: readonly number[] = [2_000, 4_000, 8_000];
let throughputBackoffMs = DEFAULT_THROUGHPUT_BACKOFF_MS;

/** Test-only. null restores the production schedule. */
export function setBulkDispatchThroughputBackoffForTests(
  delaysMs: readonly number[] | null,
): void {
  throughputBackoffMs = delaysMs ?? DEFAULT_THROUGHPUT_BACKOFF_MS;
}

/**
 * Shared by one batch: once any item still gets 130429 after every resend,
 * throughput is not freeing up, so the rest of the batch stops waiting. That
 * bounds the batch's time and its extra provider calls.
 */
type ThroughputBackoffState = { exhausted: boolean };

function isMetaThroughputRejection(
  item: BulkCampaignDispatchItem,
  result: { success: boolean; provider?: string; providerCode?: string } & {
    providerRequestAttempted?: true;
    providerAcceptanceUnknown?: true;
  },
): boolean {
  return (
    item.channel === "whatsapp" &&
    !result.success &&
    result.provider === "meta" &&
    result.providerCode === META_THROUGHPUT_ERROR_CODE &&
    result.providerRequestAttempted === true &&
    result.providerAcceptanceUnknown !== true
  );
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error || "Unknown error");
}

function resolveRecipientLabel(item: BulkCampaignDispatchItem): string {
  if (item.channel === "whatsapp") {
    return item.recipient.phone;
  }
  if (item.channel === "telegram") {
    return item.recipient.chatId;
  }
  return item.recipient.email;
}

async function resolveBulkCampaignTelegramBotToken(
  item: Extract<BulkCampaignDispatchItem, { channel: "telegram" }>,
): Promise<string | undefined> {
  if (!item.sourceId) {
    return undefined;
  }

  const validation = await fetchAndValidateTelegramSource(item.sourceId);
  if (!validation.valid || !validation.source) {
    throw new Error(
      validation.error ||
        "Telegram send context is unavailable for this campaign item",
    );
  }

  if (validation.source.workspace_id !== item.workspaceId) {
    throw new Error("Telegram source does not belong to this workspace");
  }

  if (!validation.botToken) {
    throw new Error("Telegram source is missing bot_token in credentials");
  }

  return validation.botToken;
}

async function recordDedupeWithRetries(params: {
  key: string;
  workspaceId: string;
  channel: BulkCampaignDispatchChannel;
  messageId: string;
  recipient: string;
}): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await recordBulkDispatchActivityDedupe(params);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 120 * attempt));
      }
    }
  }
  airiWorkerLogger.error(
    "airi.worker.bulk_campaign",
    lastError instanceof Error ? lastError : new Error(String(lastError)),
    {
      note: "record_dispatch_dedupe_failed",
      key: params.key,
    },
  );
}

async function dispatchSingleBulkCampaignItem(
  item: BulkCampaignDispatchItem,
  dedupeKey: string | undefined,
  batchIndex: number,
  activityContext: BulkCampaignDispatchActivityContext | undefined,
  resolveWhatsAppSendContextForBatch: ResolveBulkCampaignWhatsAppSendContext,
  resolveWhatsAppReadinessForBatch: ResolveBulkCampaignWhatsAppSendingReadiness,
  providerCircuit: NonNullable<
    BulkCampaignDispatchBatchResult["providerCircuit"]
  >,
  conversationLookupCache?: CampaignConversationLookupCache,
  throughputBackoff: ThroughputBackoffState = { exhausted: false },
): Promise<BulkCampaignDispatchSendResult> {
  const recipient = resolveRecipientLabel(item);
  let attemptedAt: string | undefined;
  let providerIntentToken: string | null = null;
  let providerIntentError: unknown;
  let providerAccepted = false;
  const unknownAcceptance = () =>
    new BulkCampaignLifecyclePersistenceError(
      "WhatsApp provider acceptance is unknown; reconcile the existing send before retrying",
    );
  const wideBase = () => ({
    ...itemDispatchLogFields(item, batchIndex),
    ...temporalContextFields(activityContext),
    ...readWorkerDeploymentMeta(),
  });
  const skipForProviderCircuit = (): BulkCampaignDispatchSendResult => ({
    channel: item.channel,
    recipient,
    success: false,
    attempted: false,
    error: "provider_circuit_open",
    failureScope: "provider",
    provider: providerCircuit.provider,
    code: providerCircuit.code,
  });
  const isProviderCircuitOpen = () => providerCircuit.state === "open";

  // Starts with the recovery reads. It is awaited, and a failure surfaces,
  // only where the send path used to call it. A circuit that is already open
  // stays open, so those items never reach that point and skip the read.
  const capacityCheck = isProviderCircuitOpen()
    ? null
    : ensureCompanyConversationCapacity(supabaseAdmin, item.workspaceId);
  capacityCheck?.catch(() => undefined);

  try {
    if (dedupeKey) {
      let existing;
      let recoveredAcceptance = false;
      try {
        // One read gives the stored witness and the send intent. SQL recovery
        // still runs only when the Mongo receipt is readable and missing.
        const state = await findBulkDispatchActivityState(dedupeKey);
        existing = state.accepted;
        if (!existing && item.channel === "whatsapp") {
          const identity = lifecyclePersistenceIdentity({
            item,
            context: activityContext,
          });
          if (identity) {
            const acceptance = await findCampaignMessageAcceptance({
              ...identity,
              workspaceId: item.workspaceId,
              channel: item.channel,
              provider: "meta",
            });
            if (acceptance) {
              existing = { ...acceptance, channel: item.channel, recipient };
              recoveredAcceptance = true;
            }
          }
        }
        if (!existing && item.channel === "whatsapp" && state.readIntent()) {
          throw unknownAcceptance();
        }
      } catch (error) {
        if (item.channel !== "whatsapp") throw error;
        // Unknown acceptance must retry bookkeeping, not send or record a
        // recipient failure that could replace the existing acceptance witness.
        throw new BulkCampaignLifecyclePersistenceError(
          normalizeErrorMessage(error),
        );
      }
      if (existing) {
        if (recoveredAcceptance) {
          await recordDedupeWithRetries({
            key: dedupeKey,
            workspaceId: item.workspaceId,
            channel: item.channel,
            messageId: existing.messageId,
            recipient,
          });
        }
        const persistenceIdentity = lifecyclePersistenceIdentity({
          item,
          context: activityContext,
        });
        if (persistenceIdentity) {
          const persistResult = await persistSentWithRetries({
            campaignId: persistenceIdentity.campaignId,
            snapshotOrdinal: persistenceIdentity.snapshotOrdinal,
            messageId: existing.messageId,
            channel: item.channel,
            recipient: persistenceIdentity.recipient,
            phone:
              item.channel === "whatsapp"
                ? persistenceIdentity.recipient
                : undefined,
            attemptedAt: new Date().toISOString(),
            scenarioId: item.scenarioId || undefined,
            scenarioNodeId: item.scenarioNodeId || undefined,
            executionSource: item.executionSource || undefined,
          });
          if (!persistResult.applied && !persistResult.queuedToOutbox) {
            throw new BulkCampaignLifecyclePersistenceError(
              persistResult.errorMessage ||
                "Unable to persist deduplicated lifecycle send",
            );
          }
        }
        await persistWhatsAppConversationForResult({
          item,
          messageId: existing.messageId,
          wideBase,
          lookupCache: conversationLookupCache,
        });
        await persistEmailConversationForResult({
          item,
          messageId: existing.messageId,
          wideBase,
        });
        return {
          channel: existing.channel,
          recipient: existing.recipient,
          success: true,
          messageId: existing.messageId,
          deduped: true,
        };
      }
    }

    // Recover an already accepted item above before suppressing new provider I/O.
    // This keeps progress monotonic when a failed activity replays after a callback.
    if (isProviderCircuitOpen()) return skipForProviderCircuit();

    if (
      item.channel === "whatsapp" &&
      item.whatsappMessageType === "service_text"
    ) {
      const serviceWindowExpiresAt = Date.parse(
        item.serviceWindowExpiresAt || "",
      );
      if (
        !Number.isFinite(serviceWindowExpiresAt) ||
        Date.now() >= serviceWindowExpiresAt
      ) {
        airiWorkerLogger.warn("airi.worker.bulk_campaign", {
          note: "bulk_dispatch_service_window_closed",
          outcome: "skipped",
          stage: "pre_transport_service_window_check",
          reason: "whatsapp_service_window_closed",
          ...wideBase(),
        });
        return {
          channel: "whatsapp",
          recipient,
          success: false,
          attempted: false,
          error: "whatsapp_service_window_closed",
          failureScope: "recipient",
          provider: "meta",
        };
      }
    }

    const whatsAppContext =
      item.channel === "whatsapp"
        ? await resolveBulkCampaignWhatsAppSendContext({
            item,
            resolveSendContext: resolveWhatsAppSendContextForBatch,
          })
        : null;
    if (
      whatsAppContext &&
      item.channel === "whatsapp" &&
      item.whatsappMessageType !== "service_text"
    ) {
      const readiness = await resolveWhatsAppReadinessForBatch(whatsAppContext);
      if (readiness.state !== "ready" && !isProviderCircuitOpen()) {
        // Share the first block across this batch and return it to the existing
        // workflow circuit. Recipients remain not attempted, not failed sends.
        Object.assign(providerCircuit, {
          state: "open",
          provider: "meta",
          code:
            readiness.reasons.find((reason) => reason.providerCode)
              ?.providerCode ||
            readiness.reasons[0]?.code ||
            "meta_check_unavailable",
        });
      }
    }
    if (isProviderCircuitOpen()) return skipForProviderCircuit();

    const capacity = await (capacityCheck ??
      ensureCompanyConversationCapacity(supabaseAdmin, item.workspaceId));
    if (isProviderCircuitOpen()) return skipForProviderCircuit();
    if (!capacity.allowed) {
      attemptedAt = new Date().toISOString();
      await persistLifecycleAttemptWithRetries({
        item,
        context: activityContext,
        status: "failed",
        attemptedAt,
        failureScope: "unknown",
        error: COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
      });
      airiWorkerLogger.warn("airi.worker.bulk_campaign", {
        note: "bulk_dispatch_skipped_company_limit",
        outcome: "skipped",
        stage: "pre_transport_limit_check",
        reason: COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
        ...wideBase(),
      });
      return {
        channel: item.channel,
        recipient,
        success: false,
        error: COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
        failureScope: "unknown",
        provider: providerForChannel(item.channel),
      };
    }

    attemptedAt = new Date().toISOString();
    await persistLifecycleAttemptWithRetries({
      item,
      context: activityContext,
      status: "attempted",
      attemptedAt,
    });

    const request =
      item.channel === "whatsapp"
        ? await (async () => {
            const context = whatsAppContext!;
            const bizOpaqueCallbackData = item.campaignId
              ? buildCampaignCallbackData({
                  campaignId: item.campaignId,
                  workspaceId: item.workspaceId,
                })
              : null;
            const baseRequest = {
              channel: "whatsapp" as const,
              contactPolicy: {
                workspaceId: item.workspaceId,
                // A failed status for this send can rebuild the campaign key
                // and release the slot; the activity key is only a fallback.
                deliveryKey:
                  buildCampaignContactDeliveryKey(
                    item.campaignId,
                    item.recipient.phone,
                  ) ||
                  dedupeKey ||
                  `campaign:${item.campaignId}:${recipient}`,
              },
              recipient: { phone: item.recipient.phone },
              phoneNumberId: context.phoneNumberId,
              accessToken: context.accessToken,
              ...(dedupeKey
                ? {
                    beforeProviderSend: async () => {
                      try {
                        providerIntentToken =
                          await claimBulkDispatchActivityIntent({
                            key: dedupeKey,
                            workspaceId: item.workspaceId,
                            channel: item.channel,
                            recipient,
                          });
                        if (!providerIntentToken) throw unknownAcceptance();
                      } catch (error) {
                        // Transport returns local hook errors as failures. Preserve
                        // this boundary so they retry bookkeeping, never recipients.
                        providerIntentError = error;
                        throw error;
                      }
                    },
                  }
                : {}),
            };
            if (item.whatsappMessageType === "service_text") {
              return {
                ...baseRequest,
                whatsappMessageType: "service_text" as const,
                messageText: item.messageText,
              };
            }
            return {
              ...baseRequest,
              messagingAccountId: context.messagingAccountId,
              marketingMessagesEnabled:
                context.marketingMessagesEnabled === true,
              marketingMessagePricing: item.marketingMessagePricing,
              templateName: item.templateName,
              languageCode: item.languageCode || "en",
              templateCategory: item.templateCategory,
              components: item.components,
              requirePhoneRecipient: item.templateCategory === "AUTHENTICATION",
              ...(bizOpaqueCallbackData ? { bizOpaqueCallbackData } : {}),
            };
          })()
        : item.channel === "telegram"
          ? await (async () => {
              const botToken = await resolveBulkCampaignTelegramBotToken(item);
              return {
                channel: "telegram" as const,
                recipient: { chatId: item.recipient.chatId },
                messageText: item.messageText,
                ...(botToken ? { botToken } : {}),
                ...(item.businessConnectionId
                  ? { businessConnectionId: item.businessConnectionId }
                  : {}),
              };
            })()
          : {
              channel: "email",
              workspaceId: item.workspaceId,
              recipient: {
                email: item.recipient.email,
                variables: item.recipient.variables,
              },
              fromAddress: item.fromAddress,
              templateKey: item.templateKey,
              templateModel: item.templateModel,
              subjectOverride: item.subjectOverride,
              emailContent: item.emailContent,
              messageStream: item.messageStream,
            };

    if (isProviderCircuitOpen()) return skipForProviderCircuit();
    let result = await sendCampaignTransportSingle(request);
    let throughputRetries = 0;
    for (
      ;
      !providerIntentError &&
      throughputRetries < throughputBackoffMs.length &&
      !throughputBackoff.exhausted &&
      isMetaThroughputRejection(item, result) &&
      !isProviderCircuitOpen();
      throughputRetries += 1
    ) {
      // The rejection is definite: release the claim, wait for throughput to
      // free up, then send the same recipient again through the same path.
      if (providerIntentToken && dedupeKey) {
        await clearBulkDispatchActivityIntent({
          key: dedupeKey,
          intentToken: providerIntentToken,
        });
        providerIntentToken = null;
      }
      const delayMs = Math.round(
        throughputBackoffMs[throughputRetries]! * (0.75 + Math.random() * 0.5),
      );
      airiWorkerLogger.warn("airi.worker.bulk_campaign", {
        note: "bulk_dispatch_throughput_backoff",
        outcome: "retrying",
        stage: "transport_send",
        providerCode: result.providerCode,
        retry: throughputRetries + 1,
        delayMs,
        ...wideBase(),
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (isProviderCircuitOpen() || throughputBackoff.exhausted) break;
      result = await sendCampaignTransportSingle(request);
    }
    if (
      throughputRetries === throughputBackoffMs.length &&
      throughputRetries > 0 &&
      !throughputBackoff.exhausted &&
      isMetaThroughputRejection(item, result)
    ) {
      throughputBackoff.exhausted = true;
      airiWorkerLogger.warn("airi.worker.bulk_campaign", {
        note: "bulk_dispatch_throughput_exhausted",
        outcome: "stopped_retrying",
        stage: "transport_send",
        providerCode: result.providerCode,
        retries: throughputRetries,
        ...wideBase(),
      });
    }
    if (providerIntentError) {
      throw new BulkCampaignLifecyclePersistenceError(
        normalizeErrorMessage(providerIntentError),
      );
    }
    if (!result.success || !result.messageId) {
      if (item.channel === "whatsapp" && providerIntentToken && dedupeKey) {
        if (
          result.providerRequestAttempted === true &&
          result.providerAcceptanceUnknown !== true
        ) {
          await clearBulkDispatchActivityIntent({
            key: dedupeKey,
            intentToken: providerIntentToken,
          });
          providerIntentToken = null;
        } else {
          throw unknownAcceptance();
        }
      }
      const transportError = result.error || "Send returned empty message id";
      airiWorkerLogger.error(
        "airi.worker.bulk_campaign",
        new Error(transportError),
        {
          note: "bulk_dispatch_transport_failed",
          outcome: "error",
          stage: "transport_send",
          provider: result.provider,
          transportError,
          ...wideBase(),
        },
      );
      if (item.channel === "telegram") {
        await markTelegramSubscriberSendResult({
          workspaceId: item.workspaceId,
          sourceId: item.sourceId,
          chatId: item.recipient.chatId,
          success: false,
          error: transportError,
        });
      }
      await persistLifecycleAttemptWithRetries({
        item,
        context: activityContext,
        status: "failed",
        attemptedAt,
        provider: result.provider,
        providerCode: result.providerCode,
        failureScope: result.failureScope || "unknown",
        error: transportError,
      });
      return {
        channel: item.channel,
        recipient,
        success: false,
        error: transportError,
        failureScope: result.failureScope || "unknown",
        provider: result.provider || providerForChannel(item.channel),
        ...(result.providerCode ? { code: result.providerCode } : {}),
      };
    }

    providerAccepted = true;
    // Recovery accepts either record as proof of acceptance, so both are
    // written at once. The witness write logs failures and never throws.
    const dedupeRecorded = dedupeKey
      ? recordDedupeWithRetries({
          key: dedupeKey,
          workspaceId: item.workspaceId,
          channel: item.channel,
          messageId: result.messageId,
          recipient,
        })
      : Promise.resolve();

    try {
      if (item.campaignId) {
        const persistenceIdentity = lifecyclePersistenceIdentity({
          item,
          context: activityContext,
        });
        const persistResult = await persistSentWithRetries({
          campaignId: item.campaignId,
          snapshotOrdinal: persistenceIdentity?.snapshotOrdinal,
          messageId: result.messageId,
          channel: item.channel,
          recipient: persistenceIdentity?.recipient || recipient,
          phone:
            item.channel === "whatsapp"
              ? persistenceIdentity?.recipient || recipient
              : undefined,
          attemptedAt,
          scenarioId: item.scenarioId || undefined,
          scenarioNodeId: item.scenarioNodeId || undefined,
          executionSource: item.executionSource || undefined,
        });

        if (!persistResult.applied && !persistResult.queuedToOutbox) {
          airiWorkerLogger.error(
            "airi.worker.bulk_campaign",
            persistResult.errorMessage
              ? new Error(String(persistResult.errorMessage))
              : new Error("persist_sent_message_failed_after_retries"),
            {
              note: "bulk_dispatch_persist_failed",
              outcome: "error",
              stage: "persist_after_send",
              messageId: result.messageId,
              persistError: persistResult.errorMessage ?? null,
              ...wideBase(),
            },
          );
          if (activityContext?.lifecycleManaged === true) {
            throw new BulkCampaignLifecyclePersistenceError(
              persistResult.errorMessage ||
                "Unable to persist lifecycle send result",
            );
          }
        }
      }
    } finally {
      await dedupeRecorded;
    }

    await persistWhatsAppConversationForResult({
      item,
      messageId: result.messageId,
      acceptedAt: result.acceptedAt,
      wideBase,
      lookupCache: conversationLookupCache,
    });
    await persistEmailConversationForResult({
      item,
      messageId: result.messageId,
      acceptedAt: result.acceptedAt,
      wideBase,
    });

    if (item.channel === "telegram") {
      await markTelegramSubscriberSendResult({
        workspaceId: item.workspaceId,
        sourceId: item.sourceId,
        chatId: item.recipient.chatId,
        success: true,
      });
    }

    return {
      channel: item.channel,
      recipient,
      success: true,
      messageId: result.messageId,
      provider: result.provider || providerForChannel(item.channel),
    };
  } catch (error) {
    if (error instanceof BulkCampaignLifecyclePersistenceError) {
      throw error;
    }
    if (providerIntentToken && !providerAccepted) throw unknownAcceptance();
    const message = normalizeErrorMessage(error);
    attemptedAt ||= new Date().toISOString();
    airiWorkerLogger.error(
      "airi.worker.bulk_campaign",
      error instanceof Error ? error : new Error(message),
      {
        note: "bulk_dispatch_item_exception",
        outcome: "error",
        stage:
          item.channel === "whatsapp"
            ? "whatsapp_resolve_context_or_send"
            : "dispatch",
        normalizedError: message,
        ...wideBase(),
      },
    );
    if (item.channel === "telegram") {
      await markTelegramSubscriberSendResult({
        workspaceId: item.workspaceId,
        sourceId: item.sourceId,
        chatId: item.recipient.chatId,
        success: false,
        error: message,
      });
    }
    await persistLifecycleAttemptWithRetries({
      item,
      context: activityContext,
      status: "failed",
      attemptedAt,
      failureScope: "unknown",
      error: message,
    });
    return {
      channel: item.channel,
      recipient,
      success: false,
      error: message,
      failureScope: "unknown",
      provider: providerForChannel(item.channel),
    };
  }
}

type IndexedBulkCampaignItem = {
  item: Extract<BulkCampaignDispatchItem, { channel: "email" }>;
  index: number;
  dedupeKey?: string;
  attemptedAt?: string;
};

async function dispatchEmailBulkCampaignItems(
  indexedItems: IndexedBulkCampaignItem[],
  activityContext: BulkCampaignDispatchActivityContext | undefined,
): Promise<BulkCampaignDispatchSendResult[]> {
  const results = new Array<BulkCampaignDispatchSendResult>(
    indexedItems.length,
  );
  const sendCandidates: Array<
    IndexedBulkCampaignItem & { resultIndex: number }
  > = [];

  for (
    let resultIndex = 0;
    resultIndex < indexedItems.length;
    resultIndex += 1
  ) {
    const indexed = indexedItems[resultIndex];
    const { item, dedupeKey, index: batchIndex } = indexed;
    const recipient = resolveRecipientLabel(item);
    const wideBase = () => ({
      ...itemDispatchLogFields(item, batchIndex),
      ...temporalContextFields(activityContext),
      ...readWorkerDeploymentMeta(),
    });

    try {
      if (dedupeKey) {
        const existing = await findBulkDispatchActivityDedupe(dedupeKey);
        if (existing) {
          const persistenceIdentity = lifecyclePersistenceIdentity({
            item,
            context: activityContext,
          });
          if (persistenceIdentity) {
            const persistResult = await persistSentWithRetries({
              campaignId: persistenceIdentity.campaignId,
              snapshotOrdinal: persistenceIdentity.snapshotOrdinal,
              messageId: existing.messageId,
              channel: "email",
              recipient: persistenceIdentity.recipient,
              attemptedAt: new Date().toISOString(),
              scenarioId: item.scenarioId || undefined,
              scenarioNodeId: item.scenarioNodeId || undefined,
              executionSource: item.executionSource || undefined,
            });
            if (!persistResult.applied && !persistResult.queuedToOutbox) {
              throw new BulkCampaignLifecyclePersistenceError(
                persistResult.errorMessage ||
                  "Unable to persist deduplicated lifecycle send",
              );
            }
          }
          await persistEmailConversationForResult({
            item,
            messageId: existing.messageId,
            wideBase,
          });
          results[resultIndex] = {
            channel: existing.channel,
            recipient: existing.recipient,
            success: true,
            messageId: existing.messageId,
            deduped: true,
          };
          continue;
        }
      }

      const capacity = await ensureCompanyConversationCapacity(
        supabaseAdmin,
        item.workspaceId,
      );
      if (!capacity.allowed) {
        const attemptedAt = new Date().toISOString();
        await persistLifecycleAttemptWithRetries({
          item,
          context: activityContext,
          status: "failed",
          attemptedAt,
          failureScope: "unknown",
          error: COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
        });
        airiWorkerLogger.warn("airi.worker.bulk_campaign", {
          note: "bulk_dispatch_skipped_company_limit",
          outcome: "skipped",
          stage: "pre_transport_limit_check",
          reason: COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
          ...wideBase(),
        });
        results[resultIndex] = {
          channel: "email",
          recipient,
          success: false,
          error: COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
          failureScope: "unknown",
          provider: "postmark",
        };
        continue;
      }

      sendCandidates.push({ ...indexed, resultIndex });
    } catch (error) {
      if (error instanceof BulkCampaignLifecyclePersistenceError) {
        throw error;
      }
      const message = normalizeErrorMessage(error);
      const attemptedAt = new Date().toISOString();
      airiWorkerLogger.error(
        "airi.worker.bulk_campaign",
        error instanceof Error ? error : new Error(message),
        {
          note: "bulk_dispatch_email_preflight_exception",
          outcome: "error",
          stage: "dispatch",
          normalizedError: message,
          ...wideBase(),
        },
      );
      await persistLifecycleAttemptWithRetries({
        item,
        context: activityContext,
        status: "failed",
        attemptedAt,
        failureScope: "unknown",
        error: message,
      });
      results[resultIndex] = {
        channel: "email",
        recipient,
        success: false,
        error: message,
        failureScope: "unknown",
        provider: "postmark",
      };
    }
  }

  const candidatesByWorkspace = new Map<
    string,
    Array<IndexedBulkCampaignItem & { resultIndex: number }>
  >();
  for (const candidate of sendCandidates) {
    const group = candidatesByWorkspace.get(candidate.item.workspaceId) || [];
    group.push(candidate);
    candidatesByWorkspace.set(candidate.item.workspaceId, group);
  }

  for (const [workspaceId, candidates] of candidatesByWorkspace) {
    for (const candidate of candidates) {
      candidate.attemptedAt = new Date().toISOString();
      await persistLifecycleAttemptWithRetries({
        item: candidate.item,
        context: activityContext,
        status: "attempted",
        attemptedAt: candidate.attemptedAt,
      });
    }

    const batchResult = await sendCampaignTransportBatch({
      channel: "email",
      workspaceId,
      messages: candidates.map(({ item }) => ({
        recipient: {
          email: item.recipient.email,
          variables: item.recipient.variables,
        },
        templateKey: item.templateKey,
        templateModel: item.templateModel,
        subjectOverride: item.subjectOverride,
        emailContent: item.emailContent,
        messageStream: item.messageStream,
      })),
    });

    for (
      let candidateIndex = 0;
      candidateIndex < candidates.length;
      candidateIndex += 1
    ) {
      const candidate = candidates[candidateIndex];
      const { item, dedupeKey, index: batchIndex, resultIndex } = candidate;
      const recipient = resolveRecipientLabel(item);
      const transportResult = batchResult.results[candidateIndex];
      const wideBase = () => ({
        ...itemDispatchLogFields(item, batchIndex),
        ...temporalContextFields(activityContext),
        ...readWorkerDeploymentMeta(),
      });

      if (!transportResult?.success || !transportResult.messageId) {
        const transportError =
          transportResult?.error ||
          batchResult.error ||
          "Send returned empty message id";
        airiWorkerLogger.error(
          "airi.worker.bulk_campaign",
          new Error(transportError),
          {
            note: "bulk_dispatch_transport_failed",
            outcome: "error",
            stage: "transport_send",
            provider: transportResult?.provider,
            transportError,
            ...wideBase(),
          },
        );
        await persistLifecycleAttemptWithRetries({
          item,
          context: activityContext,
          status: "failed",
          attemptedAt: candidate.attemptedAt!,
          provider: transportResult?.provider || "postmark",
          providerCode: transportResult?.providerCode,
          failureScope: transportResult?.failureScope || "unknown",
          error: transportError,
        });
        results[resultIndex] = {
          channel: "email",
          recipient,
          success: false,
          error: transportError,
          failureScope: transportResult?.failureScope || "unknown",
          provider: transportResult?.provider || "postmark",
          ...(transportResult?.providerCode
            ? { code: transportResult.providerCode }
            : {}),
        };
        continue;
      }

      if (dedupeKey) {
        await recordDedupeWithRetries({
          key: dedupeKey,
          workspaceId: item.workspaceId,
          channel: "email",
          messageId: transportResult.messageId,
          recipient,
        });
      }

      if (item.campaignId) {
        const persistenceIdentity = lifecyclePersistenceIdentity({
          item,
          context: activityContext,
        });
        const persistResult = await persistSentWithRetries({
          campaignId: item.campaignId,
          snapshotOrdinal: persistenceIdentity?.snapshotOrdinal,
          messageId: transportResult.messageId,
          channel: "email",
          recipient: persistenceIdentity?.recipient || recipient,
          attemptedAt: candidate.attemptedAt,
          scenarioId: item.scenarioId || undefined,
          scenarioNodeId: item.scenarioNodeId || undefined,
          executionSource: item.executionSource || undefined,
        });

        if (!persistResult.applied && !persistResult.queuedToOutbox) {
          airiWorkerLogger.error(
            "airi.worker.bulk_campaign",
            persistResult.errorMessage
              ? new Error(String(persistResult.errorMessage))
              : new Error("persist_sent_message_failed_after_retries"),
            {
              note: "bulk_dispatch_persist_failed",
              outcome: "error",
              stage: "persist_after_send",
              messageId: transportResult.messageId,
              persistError: persistResult.errorMessage ?? null,
              ...wideBase(),
            },
          );
          if (activityContext?.lifecycleManaged === true) {
            throw new BulkCampaignLifecyclePersistenceError(
              persistResult.errorMessage ||
                "Unable to persist lifecycle send result",
            );
          }
        }
      }

      await persistEmailConversationForResult({
        item,
        messageId: transportResult.messageId,
        acceptedAt: transportResult.acceptedAt,
        wideBase,
      });

      results[resultIndex] = {
        channel: "email",
        recipient,
        success: true,
        messageId: transportResult.messageId,
        provider: transportResult.provider || "postmark",
      };
    }
  }

  return results;
}

async function persistWhatsAppConversationForResult(params: {
  item: BulkCampaignDispatchItem;
  messageId: string;
  acceptedAt?: string;
  wideBase: () => Record<string, unknown>;
  lookupCache?: CampaignConversationLookupCache;
}) {
  const item = params.item;
  if (item.channel !== "whatsapp") {
    return;
  }

  try {
    const conversationPersistResult =
      await persistCampaignWhatsAppConversationMessage({
        workspaceId: item.workspaceId,
        sourceId: item.sourceId,
        phoneNumberId: item.phoneNumberId,
        recipientPhone: item.recipient.phone,
        recipientEmail: item.recipient.email,
        recipientName: item.recipient.name ?? null,
        messageId: params.messageId,
        campaignId: item.campaignId || null,
        scenarioId: item.scenarioId || null,
        nodeId: item.scenarioNodeId || null,
        executionSource: item.executionSource || null,
        sentByUserId: item.sentByUserId || null,
        sentAt: params.acceptedAt || null,
        lookupCache: params.lookupCache,
        // The worker stays up, so realtime fanout need not hold the slot.
        awaitRealtime: false,
        ...(item.whatsappMessageType === "service_text"
          ? {
              whatsappMessageType: "service_text",
              messageText: item.messageText,
            }
          : {
              whatsappMessageType: "template",
              templateName: item.templateName,
              languageCode: item.languageCode || "en",
              components: item.components,
              templateCategory: item.templateCategory || null,
            }),
      });
    if (!conversationPersistResult.persisted) {
      airiWorkerLogger.warn("airi.worker.bulk_campaign", {
        note: "bulk_dispatch_conversation_persist_skipped",
        outcome: "skipped",
        stage: "persist_conversation_message",
        reason: conversationPersistResult.reason || "unknown",
        messageId: params.messageId,
        ...params.wideBase(),
      });
    }
  } catch (persistConversationError) {
    airiWorkerLogger.error(
      "airi.worker.bulk_campaign",
      persistConversationError instanceof Error
        ? persistConversationError
        : new Error(String(persistConversationError)),
      {
        note: "bulk_dispatch_conversation_persist_failed",
        outcome: "error",
        stage: "persist_conversation_message",
        messageId: params.messageId,
        ...params.wideBase(),
      },
    );
  }
}

async function persistEmailConversationForResult(params: {
  item: BulkCampaignDispatchItem;
  messageId: string;
  acceptedAt?: string;
  wideBase: () => Record<string, unknown>;
}) {
  const item = params.item;
  if (item.channel !== "email") {
    return;
  }

  try {
    const rendered = await renderCampaignEmail({
      templateKey: item.templateKey || null,
      templateModel: item.templateModel || {},
      subjectOverride: item.subjectOverride || null,
      emailContent: item.emailContent,
    });
    const conversationPersistResult =
      await persistCampaignEmailConversationMessage({
        workspaceId: item.workspaceId,
        recipientEmail: item.recipient.email,
        fromAddress: item.fromAddress,
        messageId: params.messageId,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        campaignId: item.campaignId || null,
        scenarioId: item.scenarioId || null,
        nodeId: item.scenarioNodeId || null,
        executionSource: item.executionSource || null,
        sentByUserId: item.sentByUserId || null,
        sentAt: params.acceptedAt || null,
      });
    if (!conversationPersistResult.persisted) {
      airiWorkerLogger.warn("airi.worker.bulk_campaign", {
        note: "bulk_dispatch_email_conversation_persist_skipped",
        outcome: "skipped",
        stage: "persist_conversation_message",
        reason: conversationPersistResult.reason || "unknown",
        messageId: params.messageId,
        ...params.wideBase(),
      });
    }
  } catch (persistConversationError) {
    airiWorkerLogger.error(
      "airi.worker.bulk_campaign",
      persistConversationError instanceof Error
        ? persistConversationError
        : new Error(String(persistConversationError)),
      {
        note: "bulk_dispatch_email_conversation_persist_failed",
        outcome: "error",
        stage: "persist_conversation_message",
        messageId: params.messageId,
        ...params.wideBase(),
      },
    );
  }
}

export async function dispatchBulkCampaignBatch(
  items: BulkCampaignDispatchItem[],
  context?: BulkCampaignDispatchActivityContext,
): Promise<BulkCampaignDispatchBatchResult> {
  const batchStartedAt = Date.now();
  await connectDB();

  const firstItem = items[0];
  let persistedProviderCircuit: NonNullable<
    BulkCampaignDispatchBatchResult["providerCircuit"]
  > = { state: "closed" };
  if (context?.lifecycleManaged && firstItem?.channel === "whatsapp") {
    if (
      !context.campaignId ||
      items.some(
        (item) =>
          item.campaignId !== context.campaignId ||
          item.workspaceId !== firstItem.workspaceId ||
          item.channel !== "whatsapp",
      )
    ) {
      throw new Error(
        "Campaign circuit lookup requires one workspace-scoped campaign batch",
      );
    }
    persistedProviderCircuit = await getCampaignDispatchProviderCircuit({
      supabase: supabaseAdmin,
      workspaceId: firstItem.workspaceId,
      campaignId: context.campaignId,
    });
  }

  const results = new Array<BulkCampaignDispatchSendResult>(items.length);
  const resolveWhatsAppSendContextForBatch =
    createBatchScopedWhatsAppSendContextResolver(
      resolveFreshWhatsAppSendContext,
    );
  const resolveWhatsAppReadinessForBatch =
    createBatchScopedWhatsAppSendingReadinessResolver(getWABASendingReadiness);
  const conversationLookupCache: CampaignConversationLookupCache = {
    authors: new Map(),
    templateComponents: new Map(),
  };
  const throughputBackoff: ThroughputBackoffState = { exhausted: false };
  const emailItems: IndexedBulkCampaignItem[] = [];
  const nonEmailItems: Array<{
    item: Exclude<BulkCampaignDispatchItem, { channel: "email" }>;
    index: number;
    dedupeKey?: string;
  }> = [];

  items.forEach((item, index) => {
    const dedupeKey = context
      ? `${context.activityDedupePrefix}:${index}`
      : undefined;
    if (item.channel === "email") {
      emailItems.push({ item, index, dedupeKey });
      return;
    }
    nonEmailItems.push({ item, index, dedupeKey });
  });

  const dispatchConcurrency = resolveBulkCampaignDispatchConcurrency();
  const nonEmailResults = await mapPool(
    nonEmailItems,
    dispatchConcurrency,
    ({ item, index, dedupeKey }) =>
      dispatchSingleBulkCampaignItem(
        item,
        dedupeKey,
        index,
        context,
        resolveWhatsAppSendContextForBatch,
        resolveWhatsAppReadinessForBatch,
        persistedProviderCircuit,
        conversationLookupCache,
        throughputBackoff,
      ),
  );
  nonEmailResults.forEach((result, resultIndex) => {
    const targetIndex = nonEmailItems[resultIndex]?.index;
    if (targetIndex !== undefined) results[targetIndex] = result;
  });

  if (emailItems.length > 0) {
    const emailResults = await dispatchEmailBulkCampaignItems(
      emailItems,
      context,
    );
    emailResults.forEach((result, resultIndex) => {
      const targetIndex = emailItems[resultIndex]?.index;
      if (targetIndex !== undefined) results[targetIndex] = result;
    });
  }

  const successfulSends = results.filter((result) => result?.success).length;
  const notAttemptedSends = results.filter(
    (result) => result?.attempted === false,
  ).length;
  const failedSends = results.length - successfulSends - notAttemptedSends;
  const providerCircuit =
    persistedProviderCircuit?.state === "open"
      ? persistedProviderCircuit
      : classifyBulkCampaignProviderCircuit({
          batchStatus: "completed",
          results,
        });

  const failures = results.filter((r) => !r?.success);
  const failedSamples = failures.slice(0, 12).map((r) => ({
    channel: r.channel,
    recipient: r.recipient,
    error: r.error || "unknown",
  }));

  airiWorkerLogger.info("airi.worker.bulk_campaign", {
    note: "dispatch_batch_complete",
    outcome:
      failedSends === 0 && notAttemptedSends === 0
        ? "success"
        : "partial_failure",
    itemCount: items.length,
    successfulSends,
    failedSends,
    notAttemptedSends,
    failedSampleCount: failures.length,
    failedSamples,
    providerCircuit,
    durationMs: Date.now() - batchStartedAt,
    dispatchConcurrency,
    firstItemChannel: items[0]?.channel ?? null,
    firstTemplateName:
      items[0]?.channel === "whatsapp" &&
      items[0].whatsappMessageType !== "service_text"
        ? items[0].templateName
        : null,
    ...readWorkerDeploymentMeta(),
    ...temporalContextFields(context),
  });

  return {
    results,
    successfulSends,
    failedSends,
    notAttemptedSends,
    providerCircuit,
  };
}

async function reconcileLegacyCampaignStats(
  input: BulkCampaignDispatchFinalizeInput,
): Promise<void> {
  const reconciliation = await reconcileLegacyCampaignSendTotals({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId!,
    totals: {
      successfulSends: input.successfulSends,
      failedSends: input.failedSends,
    },
  });
  if (reconciliation.ok) return;

  airiWorkerLogger.error(
    "airi.worker.bulk_campaign",
    new Error(reconciliation.error),
    {
      campaignId: input.campaignId,
      note: "legacy_campaign_stats_reconcile_failed",
    },
  );
  throw new Error(reconciliation.error);
}

export async function beginBulkCampaignDispatch(
  campaignId: string,
  expectedWorkflowId: string,
): Promise<BulkCampaignDispatchBeginResult> {
  return beginCampaignDispatch({
    supabase: supabaseAdmin,
    campaignId,
    expectedWorkflowId,
  });
}

export async function updateBulkCampaignDispatchProgress(
  input: BulkCampaignDispatchProgressInput,
): Promise<boolean> {
  return updateCampaignDispatchProgress({
    supabase: supabaseAdmin,
    ...input,
  });
}

export async function finalizeBulkCampaignDispatchLifecycle(
  input: BulkCampaignDispatchLifecycleFinalizeInput,
): Promise<void> {
  if (input.status === "cancelled") {
    const cancellation = await reconcileCampaignDispatchCancellation({
      supabase: supabaseAdmin,
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      processedCount: input.processedCount,
      acceptedCount: input.acceptedCount,
      failedCount: input.failedCount,
      attemptedCount: input.attemptedCount,
      notAttemptedCount: input.notAttemptedCount,
      stopReason: input.stopReason,
      providerCircuit: input.providerCircuit,
    });
    if (
      cancellation.outcome !== "cancelled" &&
      cancellation.outcome !== "already_cancelled"
    ) {
      throw new Error(
        `Campaign cancellation lifecycle transition was not applied: ${cancellation.outcome}`,
      );
    }
  } else {
    const applied = await finalizeCampaignDispatch({
      supabase: supabaseAdmin,
      ...input,
    });
    if (!applied) {
      throw new Error(
        `Campaign ${input.status} lifecycle transition was not applied`,
      );
    }
  }
}

export async function finalizeBulkCampaignDispatch(
  input: BulkCampaignDispatchFinalizeInput,
): Promise<void> {
  if (!input.campaignId) {
    return;
  }

  await reconcileLegacyCampaignStats(input);
}
