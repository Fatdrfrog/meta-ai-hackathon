import { isCampaignEmailBatchEnabled } from "@/lib/campaign/campaign-config";
import { BULK_CAMPAIGN_EXPIRY_GRACE_MS } from "@/lib/campaign/bulk-campaign-safety";
import {
  CAMPAIGN_DELIVERY_MAX_ATTEMPTS,
  CAMPAIGN_DELIVERY_STALE_PROCESSING_MINUTES,
  computeCampaignDeliveryRetryAt,
} from "@/lib/campaign/campaign-delivery";
import { isSchedulableBuilderBirthdayRoot } from "@/lib/campaign/campaign-runtime-utils";
import { reconcileLegacyCampaignSendTotals } from "@/lib/campaign/campaign-stats";
import { getCampaignDispatchProviderCircuit } from "@/lib/campaign/campaign-history-store";
import {
  findBulkDispatchActivityDedupe,
  recordBulkDispatchActivityDedupe,
} from "@icecore/airi-runtime/bulk-dispatch-activity-dedupe";
import {
  sendCampaignTransportBatch,
  sendCampaignTransportSingle,
  classifyCampaignTransportFailure,
} from "@/lib/campaign/campaign-transport";
import { applyBulkCampaignCronTransitions } from "@/lib/campaign/cron-transitions";
import {
  resolveEmailRecipientFromConversation,
  resolveRecipientFromConversation,
} from "@/lib/campaign/dispatch-recipients";
import {
  findCampaignMessageAcceptance,
  persistCampaignMessageAttemptWithOutbox,
  persistCampaignMessageSentWithOutbox,
} from "@/lib/cross-store-outbox";
import {
  COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
  ensureCompanyConversationCapacity,
} from "@/lib/limits/company-limits";
import connectDB from "@/lib/mongoose";
import {
  createProcessingLeaseId,
  normalizeString,
  readEntityId,
} from "@/lib/scenarios/task-utils";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { WhatsAppTemplateSendComponentInput } from "@/lib/whatsapp/templates/message-types";
import { resolveWhatsAppSendContext } from "@/lib/whatsapp/send-context";
import { getWABASendingReadiness } from "@/lib/whatsapp/waba-service";
import { resolveTelegramSendContext } from "@/lib/telegram/source-context";
import { markTelegramSubscriberSendResult } from "@/lib/telegram/subscribers";
import CampaignDeliveryTask from "@/models/campaign-delivery-task";
import { Conversation } from "@/models/conversation";
import { Scenario } from "@/models/scenario";
import type { BulkCampaignDispatchExecutionSource } from "@icecore/scenario-contracts";
import {
  buildCurrentConversationClassificationFilter,
  CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT,
  getCurrentConversationClassification,
} from "@icecore/shared/lib/conversation-classification-freshness";
import { buildCampaignCallbackData } from "@icecore/shared/lib/whatsapp/campaign-callback-data";
import { buildCampaignTaskContactDeliveryKey } from "@icecore/shared/lib/whatsapp/campaign-contact-key";
import {
  listWhatsAppPhoneIdentityVariants,
  normalizeWhatsAppPhone,
} from "@icecore/shared/lib/whatsapp/contact-identities";
import type {
  CampaignDeliveryDrainInput,
  CampaignDeliveryDrainResult,
  CampaignExecutionFinalizeInput,
} from "@icecore/temporal";
import { Types } from "mongoose";

const EMAIL_BATCH_MAX_SIZE = 500;
const PROVIDER_ACCEPTANCE_UNKNOWN_REASON = "provider_acceptance_unknown";
const CAMPAIGN_DELIVERY_TASK_STATUSES = new Set([
  "pending",
  "processing",
  "completed",
  "retry",
  "failed_terminal",
  "skipped",
]);

type CampaignDeliveryTaskRecord = {
  _id?: unknown;
  workspaceId?: string;
  scenarioId?: string;
  nodeId?: string;
  conversationId?: string | null;
  campaignId?: string | null;
  executionSource?: BulkCampaignDispatchExecutionSource;
  channel?: "whatsapp" | "telegram" | "email";
  provider?: "meta" | "telegram" | "postmark";
  deliveryMode?: "single" | "batch";
  audienceSource?: "explicit" | "dynamic" | "birthday";
  requiresRevalidation?: boolean;
  sourceId?: string | null;
  recipientPhone?: string | null;
  recipientChatId?: string | null;
  recipientEmail?: string | null;
  recipientName?: string | null;
  recipientHash?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  templateCategory?: "MARKETING" | "UTILITY" | "AUTHENTICATION" | null;
  templateComponents?: unknown;
  messageText?: string | null;
  emailTemplateKey?: string | null;
  emailTemplateModel?: Record<string, string> | null;
  emailSubjectOverride?: string | null;
  emailMessageStream?: string | null;
  nextInternalLabel?: string | null;
  dispatchAt?: Date | string;
  dispatchExpiresAt?: Date | string | null;
  campaignStartedAt?: Date | string | null;
  status?: string;
  attempts?: number;
  processingLeaseId?: string | null;
  providerAttemptStartedAt?: Date | string | null;
  providerAttemptSourceId?: string | null;
  providerAttemptPhoneNumberId?: string | null;
  providerAttemptRecipient?: string | null;
};

type ConversationSendShape = {
  _id?: unknown;
  user?: unknown;
  chat?: unknown;
  channel?: unknown;
  sourceId?: unknown;
  participants?: {
    from?: unknown[];
    to?: unknown[];
  };
  classification?: {
    category?: unknown;
  };
  classification_revision?: unknown;
  classification_meta?: {
    analysis_revision_id?: unknown;
  };
  internal_labels?: unknown[];
  whatsapp_opt_in?: {
    status?: unknown;
  };
  bulk_campaign_history?: Array<{
    scenarioId?: unknown;
    scheduleId?: unknown;
    nodeId?: unknown;
  }>;
};

type CapturedConversationClassificationIdentity = {
  analysisRevisionId: string;
  sourceRevision: number;
};

type CapturedCategoryAudience = {
  expectedCategory: string;
  identity: CapturedConversationClassificationIdentity;
};

type CampaignScenarioNode = {
  id?: string;
  data?: Record<string, unknown>;
};

type CampaignScenarioRecord = {
  _id?: unknown;
  workspaceId?: string;
  mode?: string;
  status?: string;
  nodes?: CampaignScenarioNode[];
};

function buildCampaignTaskScopeQuery(params: {
  workspaceId: string;
  campaignId: string;
}) {
  return {
    workspaceId: params.workspaceId,
    campaignId: params.campaignId,
  };
}

function buildExpiredDispatchCondition(now: Date) {
  const legacyExpiryCutoff = new Date(
    now.getTime() - BULK_CAMPAIGN_EXPIRY_GRACE_MS
  );
  return {
    $and: [
      { campaignStartedAt: null },
      {
        $or: [
          { dispatchExpiresAt: { $lte: now } },
          {
            dispatchExpiresAt: null,
            dispatchAt: { $lte: legacyExpiryCutoff },
          },
        ],
      },
    ],
  };
}

function buildUnexpiredDispatchCondition(now: Date) {
  const legacyExpiryCutoff = new Date(
    now.getTime() - BULK_CAMPAIGN_EXPIRY_GRACE_MS
  );
  return {
    $or: [
      { campaignStartedAt: { $ne: null } },
      { dispatchExpiresAt: { $gt: now } },
      {
        dispatchExpiresAt: null,
        dispatchAt: { $gt: legacyExpiryCutoff },
      },
    ],
  };
}

function resolveCampaignStartedAt(
  value: Date | string | null | undefined,
  fallback: Date
) {
  const persisted = new Date(value || "");
  return Number.isFinite(persisted.getTime()) ? persisted : fallback;
}

async function propagateCampaignDeliveryStarted(params: {
  workspaceId: string;
  campaignId: string;
  campaignStartedAt: Date;
}) {
  await CampaignDeliveryTask.updateMany(
    {
      ...buildCampaignTaskScopeQuery(params),
      campaignStartedAt: null,
    },
    {
      $set: {
        campaignStartedAt: params.campaignStartedAt,
      },
    }
  );
}

async function markCampaignDeliveryStarted(params: {
  workspaceId: string;
  campaignId: string;
  now: Date;
}): Promise<boolean> {
  const scope = buildCampaignTaskScopeQuery(params);
  const startEvidence = await CampaignDeliveryTask.findOne({
    ...scope,
    $or: [
      { campaignStartedAt: { $ne: null } },
      {
        status: {
          $in: ["processing", "completed", "failed_terminal"],
        },
      },
      {
        status: { $in: ["retry", "skipped"] },
        attempts: { $gt: 0 },
      },
    ],
  })
    .select("_id campaignStartedAt")
    .lean<{
      _id?: unknown;
      campaignStartedAt?: Date | string | null;
    } | null>();

  if (!startEvidence?._id) {
    return false;
  }

  await propagateCampaignDeliveryStarted({
    ...params,
    campaignStartedAt: resolveCampaignStartedAt(
      startEvidence.campaignStartedAt,
      params.now
    ),
  });
  return true;
}

function resolveTaskDispatchExpiresAt(
  task: CampaignDeliveryTaskRecord
): Date | null {
  const persistedExpiry = new Date(task.dispatchExpiresAt || "");
  if (Number.isFinite(persistedExpiry.getTime())) {
    return persistedExpiry;
  }

  const legacyDispatchAt = new Date(task.dispatchAt || "");
  if (!Number.isFinite(legacyDispatchAt.getTime())) {
    return null;
  }
  return new Date(legacyDispatchAt.getTime() + BULK_CAMPAIGN_EXPIRY_GRACE_MS);
}

async function loadConversationForTask(params: {
  conversationId: string;
  workspaceId: string;
  channel: "whatsapp" | "telegram" | "email";
}) {
  return Conversation.findOne({
    _id: params.conversationId,
    workspaceId: params.workspaceId,
    channel: params.channel,
  })
    .select(
      `_id user chat channel sourceId participants classification.category ${CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT} internal_labels whatsapp_opt_in.status bulk_campaign_history`
    )
    .lean<ConversationSendShape | null>();
}

async function loadScenarioNodeForTask(params: {
  workspaceId: string;
  scenarioId: string;
  nodeId: string;
}) {
  // No mode filter: builder campaign tasks come from conversation-mode
  // scenarios. Only node-run writes scenario-backed tasks.
  const scenario = (await Scenario.findOne({
    _id: params.scenarioId,
    workspaceId: params.workspaceId,
    deletedAt: null,
  })
    .select("_id workspaceId mode status nodes")
    .lean()) as CampaignScenarioRecord | null;

  if (!scenario) {
    return { scenario: null, nodeData: null };
  }

  const nodes = Array.isArray(scenario.nodes) ? scenario.nodes : [];
  const node =
    nodes.find(item => String(item?.id || "") === params.nodeId) || null;
  // Outside legacy bulk_campaign mode only the builder root that node-run
  // schedules owns tasks; any other task, such as one left after a legacy
  // scenario turned into a conversation, finds no campaign scenario.
  if (
    String(scenario.mode || "").trim() !== "bulk_campaign" &&
    !isSchedulableBuilderBirthdayRoot(node)
  ) {
    return { scenario: null, nodeData: null };
  }
  return {
    scenario,
    nodeData: node?.data || null,
  };
}

function isScenarioBackedTask(task: CampaignDeliveryTaskRecord): boolean {
  return (
    Types.ObjectId.isValid(String(task.scenarioId || "").trim()) &&
    Boolean(String(task.nodeId || "").trim())
  );
}

function historyMatchesScenario(value: unknown, scenarioId: string): boolean {
  if (!value) return false;
  const raw = String(value).trim();
  return raw === scenarioId;
}

function hasAlreadySentForTask(params: {
  conversation: ConversationSendShape;
  scenarioId: string;
  nodeId: string;
}): boolean {
  const entries = Array.isArray(params.conversation.bulk_campaign_history)
    ? params.conversation.bulk_campaign_history
    : [];
  return entries.some(entry => {
    const historyNodeId = String(entry?.nodeId || "").trim();
    if (historyNodeId !== params.nodeId) return false;
    return (
      historyMatchesScenario(entry?.scenarioId, params.scenarioId) ||
      historyMatchesScenario(entry?.scheduleId, params.scenarioId)
    );
  });
}

function conversationMatchesDynamicAudience(params: {
  conversation: ConversationSendShape;
  channel: "whatsapp" | "telegram" | "email";
  nodeData: Record<string, unknown> | null;
}): {
  matches: boolean;
  reason?: string;
  capturedCategoryAudience?: CapturedCategoryAudience;
} {
  const nodeData = params.nodeData || {};
  const expectedCategory = String(nodeData.category || "").trim();
  const expectedInternalLabel = String(nodeData.internalLabel || "").trim();

  let capturedCategoryAudience: CapturedCategoryAudience | undefined;
  if (expectedCategory) {
    const currentClassification = getCurrentConversationClassification<{
      category?: unknown;
    }>(params.conversation);
    if (!currentClassification) {
      return { matches: false, reason: "dynamic_category_not_current" };
    }

    const actualCategory = String(currentClassification.category || "").trim();
    if (actualCategory !== expectedCategory) {
      return { matches: false, reason: "dynamic_category_mismatch" };
    }

    const sourceRevision = params.conversation.classification_revision;
    const analysisRevisionId =
      params.conversation.classification_meta?.analysis_revision_id;
    if (
      !Number.isSafeInteger(sourceRevision) ||
      typeof analysisRevisionId !== "string"
    ) {
      return { matches: false, reason: "dynamic_category_not_current" };
    }
    capturedCategoryAudience = {
      expectedCategory,
      identity: {
        analysisRevisionId,
        sourceRevision: sourceRevision as number,
      },
    };
  }

  if (expectedInternalLabel && expectedInternalLabel !== "none") {
    const labels = Array.isArray(params.conversation.internal_labels)
      ? params.conversation.internal_labels.map(value => String(value).trim())
      : [];
    if (!labels.includes(expectedInternalLabel)) {
      return { matches: false, reason: "dynamic_internal_label_mismatch" };
    }
  }

  return { matches: true, capturedCategoryAudience };
}

async function validateScenarioEligibilityForTask(params: {
  task: CampaignDeliveryTaskRecord;
  conversation?: ConversationSendShape | null;
}) {
  if (!isScenarioBackedTask(params.task)) {
    return { valid: true } as const;
  }

  const workspaceId = String(params.task.workspaceId || "").trim();
  const scenarioId = String(params.task.scenarioId || "").trim();
  const nodeId = String(params.task.nodeId || "").trim();
  const channel = params.task.channel;
  if (!workspaceId || !scenarioId || !nodeId || !channel) {
    return { valid: false, reason: "dynamic_revalidation_missing_context" };
  }

  const { scenario, nodeData } = await loadScenarioNodeForTask({
    workspaceId,
    scenarioId,
    nodeId,
  });

  if (!scenario) {
    return { valid: false, reason: "dynamic_revalidation_scenario_missing" };
  }
  if (String(scenario.status || "").trim() !== "active") {
    return { valid: false, reason: "dynamic_revalidation_scenario_inactive" };
  }
  if (!nodeData) {
    return { valid: false, reason: "scenario_node_missing" };
  }

  if (
    params.conversation &&
    hasAlreadySentForTask({
      conversation: params.conversation,
      scenarioId,
      nodeId,
    })
  ) {
    return { valid: false, reason: "already_sent_for_node" };
  }

  if (!params.task.requiresRevalidation) {
    return { valid: true } as const;
  }

  if (!params.conversation) {
    return {
      valid: false,
      reason: "dynamic_revalidation_missing_conversation",
    };
  }

  const matchResult = conversationMatchesDynamicAudience({
    conversation: params.conversation,
    channel,
    nodeData,
  });
  if (!matchResult.matches) {
    return {
      valid: false,
      reason: matchResult.reason || "dynamic_revalidation_failed",
    };
  }

  return {
    valid: true,
    capturedCategoryAudience: matchResult.capturedCategoryAudience,
  } as const;
}

async function hasCapturedCurrentCategory(params: {
  conversationId: string;
  workspaceId: string;
  capturedCategoryAudience: CapturedCategoryAudience;
}): Promise<boolean> {
  const currentFilter = buildCurrentConversationClassificationFilter();
  const analysisIdPredicate = currentFilter[
    "classification_meta.analysis_revision_id"
  ] as Record<string, unknown>;
  delete currentFilter["classification_meta.analysis_revision_id"];
  const matched = await Conversation.findOne({
    ...currentFilter,
    _id: params.conversationId,
    workspaceId: params.workspaceId,
    "classification.category": params.capturedCategoryAudience.expectedCategory,
    classification_revision:
      params.capturedCategoryAudience.identity.sourceRevision,
    "classification_meta.analysis_revision_id": {
      ...analysisIdPredicate,
      $eq: params.capturedCategoryAudience.identity.analysisRevisionId,
    },
  })
    .select("_id")
    .lean<{ _id?: unknown } | null>();
  return Boolean(matched);
}

async function skipTaskAfterCapturedCategoryMiss(params: {
  taskId: string;
  leaseId: string;
  conversationId: string;
  workspaceId: string;
  capturedCategoryAudience: CapturedCategoryAudience | null;
}) {
  if (!params.capturedCategoryAudience) return null;
  const stillCurrent = await hasCapturedCurrentCategory({
    conversationId: params.conversationId,
    workspaceId: params.workspaceId,
    capturedCategoryAudience: params.capturedCategoryAudience,
  });
  if (stillCurrent) return null;

  const reason = "dynamic_category_changed_before_send";
  await markTaskSkipped(params.taskId, params.leaseId, reason);
  return {
    status: "skipped",
    reason,
    taskId: params.taskId,
  } as const;
}

async function markTaskCompleted(taskId: string, leaseId: string) {
  await CampaignDeliveryTask.updateOne(
    { _id: taskId, status: "processing", processingLeaseId: leaseId },
    {
      $set: {
        status: "completed",
        completedAt: new Date(),
        lastError: null,
        skipReason: null,
        providerAttemptStartedAt: null,
        processingLeaseId: null,
        processingLeaseHeartbeatAt: null,
      },
    }
  );
}

async function markTaskSkipped(
  taskId: string,
  leaseId: string,
  reason: string,
  errorMessage?: string
) {
  await CampaignDeliveryTask.updateOne(
    { _id: taskId, status: "processing", processingLeaseId: leaseId },
    {
      $set: {
        status: "skipped",
        completedAt: new Date(),
        skipReason: reason,
        lastError: errorMessage || null,
        processingLeaseId: null,
        processingLeaseHeartbeatAt: null,
      },
    }
  );
}

async function markTaskFailedTerminal(
  taskId: string,
  leaseId: string,
  errorMessage: string,
  skipReason: string | null = null
) {
  await CampaignDeliveryTask.updateOne(
    { _id: taskId, status: "processing", processingLeaseId: leaseId },
    {
      $set: {
        status: "failed_terminal",
        completedAt: new Date(),
        lastError: errorMessage.slice(0, 1000),
        skipReason,
        processingLeaseId: null,
        processingLeaseHeartbeatAt: null,
      },
    }
  );
}

async function recordTaskProviderAttempt(params: {
  task: CampaignDeliveryTaskRecord;
  leaseId: string;
  sourceId?: string;
  phoneNumberId: string;
  recipient: string;
}): Promise<void> {
  const startedAt = new Date();
  const proof = {
    providerAttemptStartedAt: startedAt,
    providerAttemptSourceId: params.sourceId || null,
    providerAttemptPhoneNumberId: params.phoneNumberId,
    providerAttemptRecipient: params.recipient,
  };
  const result = await CampaignDeliveryTask.updateOne(
    {
      _id: String(params.task._id || "").trim(),
      workspaceId: params.task.workspaceId,
      campaignId: params.task.campaignId,
      status: "processing",
      processingLeaseId: params.leaseId,
      providerAttemptStartedAt: null,
    },
    { $set: proof },
    { writeConcern: { w: "majority" } }
  );
  if (result.modifiedCount !== 1) {
    throw new Error("Campaign provider attempt intent could not be recorded");
  }
  Object.assign(params.task, proof);
}

async function clearRejectedTaskProviderAttempt(params: {
  task: CampaignDeliveryTaskRecord;
  leaseId: string;
}): Promise<void> {
  const result = await CampaignDeliveryTask.updateOne(
    {
      _id: String(params.task._id || "").trim(),
      workspaceId: params.task.workspaceId,
      campaignId: params.task.campaignId,
      status: "processing",
      processingLeaseId: params.leaseId,
      providerAttemptStartedAt: params.task.providerAttemptStartedAt,
    },
    { $set: { providerAttemptStartedAt: null } },
    { writeConcern: { w: "majority" } }
  );
  if (result.modifiedCount !== 1) {
    throw new Error("Campaign rejected provider attempt could not be cleared");
  }
  params.task.providerAttemptStartedAt = null;
}

async function reconcileUnknownTaskProviderAcceptance(params: {
  task: CampaignDeliveryTaskRecord;
  leaseId: string;
}): Promise<"retry" | "failed_terminal"> {
  // Keep the durable intent through acceptance-only rechecks. No SQL failure
  // is written: a late provider callback can still prove that the send worked.
  if (Number(params.task.attempts || 1) < CAMPAIGN_DELIVERY_MAX_ATTEMPTS) {
    await markTaskRetry({
      ...params,
      errorMessage: PROVIDER_ACCEPTANCE_UNKNOWN_REASON,
      now: new Date(),
    });
    return "retry";
  }
  await markTaskFailedTerminal(
    String(params.task._id || "").trim(),
    params.leaseId,
    PROVIDER_ACCEPTANCE_UNKNOWN_REASON,
    PROVIDER_ACCEPTANCE_UNKNOWN_REASON
  );
  return "failed_terminal";
}

async function markTaskRetry(params: {
  task: CampaignDeliveryTaskRecord;
  leaseId: string;
  errorMessage: string;
  now: Date;
}) {
  const taskId = String(params.task._id || "").trim();
  const retryAt = computeCampaignDeliveryRetryAt({
    attempts: Number(params.task.attempts || 1),
    now: params.now,
  });
  const dispatchExpiresAt = resolveTaskDispatchExpiresAt(params.task);
  await CampaignDeliveryTask.updateOne(
    { _id: taskId, status: "processing", processingLeaseId: params.leaseId },
    {
      $set: {
        status: "retry",
        dispatchAt: retryAt,
        ...(dispatchExpiresAt ? { dispatchExpiresAt } : {}),
        processingStartedAt: null,
        processingLeaseId: null,
        processingLeaseHeartbeatAt: null,
        completedAt: null,
        lastError: params.errorMessage.slice(0, 1000),
        wakeMethod: null,
        wakeMessageId: null,
        wakeScheduledFor: null,
        wakePublishedAt: null,
        wakeCancelledAt: null,
      },
    }
  );
}

function ledgerTransitionOwned(
  result:
    | {
        applied?: boolean;
        queuedToOutbox?: boolean;
      }
    | null
    | undefined
): boolean {
  return Boolean(result?.applied || result?.queuedToOutbox);
}

function canonicalTaskRecipient(task: CampaignDeliveryTaskRecord): string {
  if (task.channel === "whatsapp") {
    return normalizeString(task.recipientPhone);
  }
  if (task.channel === "telegram") {
    return normalizeString(task.recipientChatId);
  }
  return normalizeString(task.recipientEmail);
}

function resolveTaskExecutionSource(
  value: CampaignDeliveryTaskRecord["executionSource"]
): BulkCampaignDispatchExecutionSource {
  switch (value) {
    case "scenario_schedule":
    case "scenario_run_now":
    case "ad_hoc":
      return value;
    case undefined:
      return "scenario_schedule";
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

function buildTaskInsertIfMissing(task: CampaignDeliveryTaskRecord) {
  return {
    messageId: `campaign-delivery-task:${String(task._id || "").trim()}`,
    workspaceId: String(task.workspaceId || "").trim(),
    recipientHash: String(task.recipientHash || "").trim(),
    scenarioId: String(task.scenarioId || "").trim(),
    scenarioNodeId: String(task.nodeId || "").trim(),
    executionSource: resolveTaskExecutionSource(task.executionSource),
  };
}

async function persistTerminalAttemptAndMaybeFail(params: {
  task: CampaignDeliveryTaskRecord;
  leaseId: string;
  errorMessage: string;
  providerCode?: string;
  failureScope?: string;
  now: Date;
}): Promise<"failed_terminal" | "retry"> {
  const taskId = String(params.task._id || "").trim();
  if (Number(params.task.attempts || 1) < CAMPAIGN_DELIVERY_MAX_ATTEMPTS) {
    await markTaskRetry({
      task: params.task,
      leaseId: params.leaseId,
      errorMessage: params.errorMessage,
      now: params.now,
    });
    return "retry";
  }

  const campaignId = String(params.task.campaignId || "").trim();
  const channel = params.task.channel;
  const recipient = canonicalTaskRecipient(params.task);
  const insertIfMissing = buildTaskInsertIfMissing(params.task);
  if (campaignId && channel && recipient && insertIfMissing.recipientHash) {
    let persistResult: { applied?: boolean; queuedToOutbox?: boolean } = {
      applied: false,
      queuedToOutbox: false,
    };
    try {
      persistResult = await persistCampaignMessageAttemptWithOutbox({
        campaignId,
        channel,
        recipient,
        phone: channel === "whatsapp" ? recipient : undefined,
        provider: params.task.provider,
        attemptedAt: params.now.toISOString(),
        status: "failed",
        failedAt: params.now.toISOString(),
        providerError: {
          code: params.providerCode,
          scope: params.failureScope,
          message: params.errorMessage,
        },
        insertIfMissing,
      });
    } catch {
      persistResult = { applied: false, queuedToOutbox: false };
    }
    if (!ledgerTransitionOwned(persistResult)) {
      await markTaskRetry({
        task: params.task,
        leaseId: params.leaseId,
        errorMessage: params.errorMessage,
        now: params.now,
      });
      return "retry";
    }
  } else {
    await markTaskRetry({
      task: params.task,
      leaseId: params.leaseId,
      errorMessage: params.errorMessage,
      now: params.now,
    });
    return "retry";
  }

  await markTaskFailedTerminal(taskId, params.leaseId, params.errorMessage);
  return "failed_terminal";
}

async function persistSuccessfulDelivery(params: {
  task: CampaignDeliveryTaskRecord;
  recipient: string;
  provider: "meta" | "telegram" | "postmark";
  messageId: string;
}): Promise<boolean> {
  const scenarioId = String(params.task.scenarioId || "").trim();
  const nodeId = String(params.task.nodeId || "").trim();
  const conversationId = String(params.task.conversationId || "").trim();
  const channel = params.task.channel;
  const linkedScenarioId = Types.ObjectId.isValid(scenarioId)
    ? scenarioId
    : undefined;
  const linkedScenarioNodeId = linkedScenarioId && nodeId ? nodeId : undefined;

  if (params.task.campaignId && channel) {
    let persistResult: { applied?: boolean; queuedToOutbox?: boolean } = {
      applied: false,
      queuedToOutbox: false,
    };
    try {
      persistResult = await persistCampaignMessageSentWithOutbox({
        campaignId: params.task.campaignId,
        messageId: params.messageId,
        channel,
        recipient: params.recipient,
        provider: params.provider,
        status: "sent",
        scenarioId: linkedScenarioId,
        scenarioNodeId: linkedScenarioNodeId,
        executionSource: params.task.executionSource,
      });
    } catch {
      persistResult = { applied: false, queuedToOutbox: false };
    }
    if (!ledgerTransitionOwned(persistResult)) {
      return false;
    }
  }

  if (conversationId && linkedScenarioId && linkedScenarioNodeId) {
    await applyBulkCampaignCronTransitions({
      scenarioId: linkedScenarioId,
      scheduleId: linkedScenarioId,
      nodeId: linkedScenarioNodeId,
      conversationId,
      templateName:
        channel === "email"
          ? String(params.task.emailTemplateKey || "")
          : String(params.task.templateName || ""),
      nextInternalLabel:
        typeof params.task.nextInternalLabel === "string"
          ? params.task.nextInternalLabel
          : undefined,
    });
  }

  return true;
}

async function completeAcceptedTaskDelivery(params: {
  task: CampaignDeliveryTaskRecord;
  leaseId: string;
  recipient: string;
  provider: "meta" | "telegram" | "postmark";
  messageId: string;
}) {
  const taskId = String(params.task._id || "").trim();
  const owned = await persistSuccessfulDelivery(params);
  if (!owned) {
    await markTaskRetry({
      task: params.task,
      leaseId: params.leaseId,
      errorMessage: "campaign_message_sent_ledger_unconfirmed",
      now: new Date(),
    });
    return { status: "retry", taskId } as const;
  }
  await markTaskCompleted(taskId, params.leaseId);
  return { status: "completed", taskId, messageId: params.messageId } as const;
}

async function processClaimedTask(params: {
  task: CampaignDeliveryTaskRecord;
  leaseId: string;
}) {
  const taskId = String(params.task._id || "").trim();
  const workspaceId = String(params.task.workspaceId || "").trim();
  const scenarioId = String(params.task.scenarioId || "").trim();
  const nodeId = String(params.task.nodeId || "").trim();
  const conversationId = String(params.task.conversationId || "").trim();
  const channel = params.task.channel;
  const recipientPhone = normalizeString(params.task.recipientPhone);
  const recipientChatId = normalizeString(params.task.recipientChatId);
  const recipientEmail = normalizeString(params.task.recipientEmail);

  if (!taskId || !workspaceId || !scenarioId || !nodeId || !channel) {
    await markTaskSkipped(taskId, params.leaseId, "invalid_task_payload");
    return {
      status: "skipped",
      reason: "invalid_task_payload",
      taskId,
    } as const;
  }

  const campaignId = normalizeString(params.task.campaignId);
  const sendReceiptKey =
    channel === "whatsapp" && campaignId
      ? `campaign-task:${workspaceId}:${taskId}`
      : null;
  if (sendReceiptKey) {
    // A prior acceptance must finish its durable bookkeeping even if the
    // campaign was restricted or its mutable audience changed after the send.
    let circuit;
    try {
      let receipt = await findBulkDispatchActivityDedupe(sendReceiptKey);
      if (!receipt) {
        const recipient = canonicalTaskRecipient(params.task);
        if (!recipient)
          throw new Error("Campaign task acceptance identity is missing");
        const acceptance = await findCampaignMessageAcceptance({
          workspaceId,
          campaignId,
          channel: "whatsapp",
          recipient,
          provider: "meta",
          pendingMessageId: buildTaskInsertIfMissing(params.task).messageId,
        });
        if (acceptance) {
          // SQL/outbox legacy identity is campaign+phone. Several conversation
          // tasks may share that phone, so it alone cannot identify this task.
          const variants = listWhatsAppPhoneIdentityVariants(recipient);
          if (!variants.length)
            throw new Error("Campaign task recipient identity is malformed");
          const separators = "[+\\s().-]*";
          const phonePattern = new RegExp(
            `^\\s*(?:wa_)?${separators}(?:${variants.map(value => value.split("").join(separators)).join("|")})${separators}$`
          );
          const owners = await CampaignDeliveryTask.find({
            workspaceId,
            campaignId,
            channel: "whatsapp",
            $or: [
              { recipientPhone: phonePattern },
              // Missing or malformed legacy phones are unknown competitors.
              {
                recipientPhone: {
                  $not: /^\s*(?:wa_)?[+\s().-]*(?:\d[+\s().-]*){6,}$/,
                },
              },
            ],
          })
            .hint("campaignId_1")
            .maxTimeMS(2_000)
            .select("_id workspaceId campaignId channel recipientPhone")
            .limit(2)
            .lean<CampaignDeliveryTaskRecord[]>();
          const owner = owners[0];
          if (
            !owner ||
            owners.length !== 1 ||
            String(owner._id || "") !== taskId ||
            owner.workspaceId !== workspaceId ||
            owner.campaignId !== campaignId ||
            owner.channel !== "whatsapp" ||
            normalizeWhatsAppPhone(owner.recipientPhone) !==
              normalizeWhatsAppPhone(recipient)
          ) {
            throw new Error("Campaign task acceptance ownership is ambiguous");
          }
          receipt = { ...acceptance, recipient, channel: "whatsapp" };
        }
      }
      if (receipt) {
        if (receipt.channel !== channel)
          throw new Error("Campaign task send receipt channel mismatch");
        return await completeAcceptedTaskDelivery({
          task: params.task,
          leaseId: params.leaseId,
          recipient: receipt.recipient,
          provider: "meta",
          messageId: receipt.messageId,
        });
      }
      if (params.task.providerAttemptStartedAt) {
        const status = await reconcileUnknownTaskProviderAcceptance(params);
        return { status, taskId } as const;
      }
      circuit = await getCampaignDispatchProviderCircuit({
        supabase: supabaseAdmin,
        workspaceId,
        campaignId,
      });
    } catch (error) {
      await markTaskRetry({
        task: params.task,
        leaseId: params.leaseId,
        errorMessage: `provider_circuit_lookup_failed: ${error instanceof Error ? error.message : String(error)}`,
        now: new Date(),
      });
      return { status: "retry", taskId } as const;
    }
    if (circuit.state === "open") {
      await markTaskSkipped(
        taskId,
        params.leaseId,
        "provider_circuit_open",
        `${circuit.provider}:${circuit.code}`
      );
      return {
        status: "skipped",
        taskId,
        reason: "provider_circuit_open",
      } as const;
    }
  }

  if (channel === "whatsapp" && params.task.providerAttemptStartedAt) {
    const status = await reconcileUnknownTaskProviderAcceptance(params);
    return { status, taskId } as const;
  }

  const hasDirectRecipient =
    (channel === "whatsapp" && Boolean(recipientPhone)) ||
    (channel === "telegram" && Boolean(recipientChatId)) ||
    (channel === "email" && Boolean(recipientEmail));

  let conversation: ConversationSendShape | null = null;
  let capturedCategoryAudience: CapturedCategoryAudience | null = null;
  if (conversationId) {
    conversation = await loadConversationForTask({
      conversationId,
      workspaceId,
      channel,
    });

    if (!conversation) {
      await markTaskSkipped(taskId, params.leaseId, "conversation_not_found");
      return {
        status: "skipped",
        reason: "conversation_not_found",
        taskId,
      } as const;
    }

    const revalidation = await validateScenarioEligibilityForTask({
      task: params.task,
      conversation,
    });
    if (!revalidation.valid) {
      await markTaskSkipped(
        taskId,
        params.leaseId,
        revalidation.reason || "dynamic_revalidation_failed"
      );
      return {
        status: "skipped",
        reason: revalidation.reason || "dynamic_revalidation_failed",
        taskId,
      } as const;
    }
    capturedCategoryAudience = revalidation.capturedCategoryAudience || null;
  } else if (!hasDirectRecipient) {
    await markTaskSkipped(taskId, params.leaseId, "missing_recipient");
    return {
      status: "skipped",
      reason: "missing_recipient",
      taskId,
    } as const;
  }

  if (!conversation) {
    const scenarioValidation = await validateScenarioEligibilityForTask({
      task: params.task,
    });
    if (!scenarioValidation.valid) {
      await markTaskSkipped(
        taskId,
        params.leaseId,
        scenarioValidation.reason || "scenario_validation_failed"
      );
      return {
        status: "skipped",
        reason: scenarioValidation.reason || "scenario_validation_failed",
        taskId,
      } as const;
    }
  }

  const capacity = await ensureCompanyConversationCapacity(
    supabaseAdmin,
    workspaceId
  );
  if (!capacity.allowed) {
    await markTaskSkipped(
      taskId,
      params.leaseId,
      COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE
    );
    return {
      status: "skipped",
      reason: COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
      taskId,
    } as const;
  }

  let sendResult;
  if (channel === "whatsapp") {
    const resolvedRecipientPhone =
      recipientPhone ||
      (conversation ? resolveRecipientFromConversation(conversation) : null);
    if (!resolvedRecipientPhone) {
      await markTaskSkipped(
        taskId,
        params.leaseId,
        "missing_whatsapp_recipient"
      );
      return {
        status: "skipped",
        reason: "missing_whatsapp_recipient",
        taskId,
      } as const;
    }

    const sendContext = await resolveWhatsAppSendContext({
      workspaceId,
      ...(String(params.task.sourceId || "").trim()
        ? { sourceId: String(params.task.sourceId).trim() }
        : {}),
    });
    if (!sendContext) {
      throw new Error("WhatsApp credentials not configured");
    }

    const readiness = await getWABASendingReadiness({
      wabaId: sendContext.wabaId,
      accessToken: sendContext.accessToken,
      maxAgeSeconds: 20,
    });
    if (readiness.state === "unavailable") {
      await markTaskRetry({
        task: params.task,
        leaseId: params.leaseId,
        errorMessage: "whatsapp_sending_unavailable",
        now: new Date(),
      });
      return { status: "retry", taskId } as const;
    }
    if (readiness.state === "blocked") {
      await markTaskSkipped(
        taskId,
        params.leaseId,
        "whatsapp_sending_blocked",
        readiness.reasons
          .map(reason => reason.providerCode || reason.code)
          .join(",")
      );
      return {
        status: "skipped",
        taskId,
        reason: "whatsapp_sending_blocked",
      } as const;
    }

    const campaignIdForCallback = params.task.campaignId
      ? String(params.task.campaignId).trim()
      : "";
    const bizOpaqueCallbackData = campaignIdForCallback
      ? buildCampaignCallbackData({
          campaignId: campaignIdForCallback,
          workspaceId,
          taskId,
        })
      : null;

    const finalCategoryMiss = await skipTaskAfterCapturedCategoryMiss({
      taskId,
      leaseId: params.leaseId,
      conversationId,
      workspaceId,
      capturedCategoryAudience,
    });
    if (finalCategoryMiss) return finalCategoryMiss;

    sendResult = await sendCampaignTransportSingle({
      channel: "whatsapp",
      recipient: { phone: resolvedRecipientPhone },
      phoneNumberId: sendContext.phoneNumberId,
      accessToken: sendContext.accessToken,
      messagingAccountId: sendContext.messagingAccountId,
      marketingMessagesEnabled: sendContext.marketingMessagesEnabled === true,
      templateName: String(params.task.templateName || "").trim(),
      languageCode: String(params.task.templateLanguage || "en").trim() || "en",
      templateCategory: params.task.templateCategory || undefined,
      contactPolicy: {
        workspaceId,
        deliveryKey: buildCampaignTaskContactDeliveryKey(taskId),
        conversationId: conversationId || undefined,
      },
      components: Array.isArray(params.task.templateComponents)
        ? (params.task
            .templateComponents as WhatsAppTemplateSendComponentInput[])
        : undefined,
      bizOpaqueCallbackData,
      beforeProviderSend: () => recordTaskProviderAttempt({
        ...params,
        sourceId: sendContext.sourceId,
        phoneNumberId: sendContext.phoneNumberId,
        recipient: resolvedRecipientPhone,
      }),
    });
  } else if (channel === "telegram") {
    const chatId =
      recipientChatId ||
      (conversation ? readEntityId(conversation.chat) : null);
    if (!chatId) {
      await markTaskSkipped(taskId, params.leaseId, "missing_telegram_chat");
      return {
        status: "skipped",
        reason: "missing_telegram_chat",
        taskId,
      } as const;
    }

    const sourceId =
      normalizeString(params.task.sourceId) ||
      (conversation ? normalizeString(conversation.sourceId) : "");
    const sendContext = await resolveTelegramSendContext({
      workspaceId,
      sourceId,
    });
    if (!sendContext) {
      throw new Error("Telegram credentials not configured");
    }

    const finalCategoryMiss = await skipTaskAfterCapturedCategoryMiss({
      taskId,
      leaseId: params.leaseId,
      conversationId,
      workspaceId,
      capturedCategoryAudience,
    });
    if (finalCategoryMiss) return finalCategoryMiss;

    sendResult = await sendCampaignTransportSingle({
      channel: "telegram",
      recipient: { chatId },
      messageText: String(params.task.messageText || "").trim(),
      botToken: sendContext.botToken,
    });
    await markTelegramSubscriberSendResult({
      workspaceId,
      sourceId: sendContext.sourceId,
      chatId,
      success: Boolean(sendResult.success && sendResult.messageId),
      error:
        sendResult.success && sendResult.messageId
          ? null
          : sendResult.error || "Campaign delivery failed",
    });
  } else {
    const resolvedRecipientEmail =
      recipientEmail ||
      (conversation
        ? resolveEmailRecipientFromConversation(conversation)
        : null);
    if (!resolvedRecipientEmail) {
      await markTaskSkipped(taskId, params.leaseId, "missing_email_recipient");
      return {
        status: "skipped",
        reason: "missing_email_recipient",
        taskId,
      } as const;
    }

    const finalCategoryMiss = await skipTaskAfterCapturedCategoryMiss({
      taskId,
      leaseId: params.leaseId,
      conversationId,
      workspaceId,
      capturedCategoryAudience,
    });
    if (finalCategoryMiss) return finalCategoryMiss;

    sendResult = await sendCampaignTransportSingle({
      channel: "email",
      workspaceId,
      recipient: { email: resolvedRecipientEmail },
      templateKey: String(params.task.emailTemplateKey || "") as
        | "announcement"
        | "product_update"
        | "event_reminder",
      templateModel: params.task.emailTemplateModel || {},
      subjectOverride: params.task.emailSubjectOverride || undefined,
      messageStream: params.task.emailMessageStream || undefined,
    });
  }

  if (!sendResult.success || !sendResult.messageId) {
    if (channel === "whatsapp" && params.task.providerAttemptStartedAt) {
      if (
        sendResult.providerRequestAttempted === true &&
        sendResult.providerAcceptanceUnknown !== true
      ) {
        await clearRejectedTaskProviderAttempt(params);
      } else {
        const status = await reconcileUnknownTaskProviderAcceptance(params);
        return { status, taskId } as const;
      }
    }
    const failureStatus = await persistTerminalAttemptAndMaybeFail({
      task: params.task,
      leaseId: params.leaseId,
      errorMessage: sendResult.error || "Campaign delivery failed",
      providerCode: sendResult.providerCode,
      failureScope: sendResult.failureScope,
      now: new Date(),
    });
    return {
      status: failureStatus,
      taskId,
    } as const;
  }

  if (sendReceiptKey) {
    try {
      await recordBulkDispatchActivityDedupe({
        key: sendReceiptKey,
        workspaceId,
        channel,
        recipient: sendResult.recipient,
        messageId: sendResult.messageId,
      });
    } catch {
      // Meta has accepted the message. Always finish the canonical sent
      // ledger/outbox write even if this auxiliary replay receipt is unavailable.
    }
  }
  return completeAcceptedTaskDelivery({
    task: params.task,
    leaseId: params.leaseId,
    recipient: sendResult.recipient,
    provider: sendResult.provider,
    messageId: sendResult.messageId,
  });
}

function buildEmailBatchSiblingQuery(params: {
  task: CampaignDeliveryTaskRecord;
  now: Date;
}) {
  const workspaceId = normalizeString(params.task.workspaceId);
  const scenarioId = normalizeString(params.task.scenarioId);
  const nodeId = normalizeString(params.task.nodeId);
  const emailTemplateKey = normalizeString(params.task.emailTemplateKey);
  if (!workspaceId || !scenarioId || !nodeId || !emailTemplateKey) {
    return null;
  }

  return {
    _id: { $ne: params.task._id },
    workspaceId,
    scenarioId,
    nodeId,
    channel: "email",
    provider: params.task.provider || "postmark",
    deliveryMode: "batch",
    emailTemplateKey,
    executionSource: params.task.executionSource || "scenario_schedule",
    campaignId: params.task.campaignId || null,
    emailSubjectOverride: params.task.emailSubjectOverride || null,
    emailMessageStream: params.task.emailMessageStream || null,
    status: { $in: ["pending", "retry"] },
    dispatchAt: { $lte: params.now },
    ...buildUnexpiredDispatchCondition(params.now),
  };
}

async function claimEmailBatchTasks(params: {
  leaderTask: CampaignDeliveryTaskRecord;
  now: Date;
  leaseId: string;
  maxTasks: number;
}) {
  const siblingQuery = buildEmailBatchSiblingQuery({
    task: params.leaderTask,
    now: params.now,
  });
  if (!siblingQuery || params.maxTasks <= 1) {
    return [params.leaderTask];
  }

  const siblingIds = (
    await CampaignDeliveryTask.find(siblingQuery)
      .sort({ dispatchAt: 1, _id: 1 })
      .limit(Math.max(0, Math.min(EMAIL_BATCH_MAX_SIZE, params.maxTasks) - 1))
      .select("_id")
      .lean<Array<{ _id?: unknown }>>()
  )
    .map(item => String(item._id || "").trim())
    .filter(Boolean);

  const claimedSiblings: CampaignDeliveryTaskRecord[] = [];
  for (const siblingId of siblingIds) {
    const claimed = await CampaignDeliveryTask.findOneAndUpdate(
      {
        _id: siblingId,
        status: { $in: ["pending", "retry"] },
        dispatchAt: { $lte: params.now },
        ...buildUnexpiredDispatchCondition(params.now),
      },
      {
        $set: {
          status: "processing",
          processingStartedAt: params.now,
          processingLeaseId: params.leaseId,
          processingLeaseHeartbeatAt: params.now,
          lastError: null,
          wakeMethod: null,
          wakeMessageId: null,
          wakeScheduledFor: null,
          wakePublishedAt: null,
        },
        $inc: { attempts: 1 },
      },
      { new: true }
    ).lean<CampaignDeliveryTaskRecord | null>();

    if (claimed) {
      claimedSiblings.push(claimed);
    }
  }

  return [params.leaderTask, ...claimedSiblings];
}

async function processClaimedEmailBatch(params: {
  tasks: CampaignDeliveryTaskRecord[];
  leaseId: string;
  now: Date;
}) {
  const validRequests: Array<{
    task: CampaignDeliveryTaskRecord;
    recipientEmail: string;
    templateKey: "announcement" | "product_update" | "event_reminder";
    templateModel: Record<string, string>;
    subjectOverride?: string;
    messageStream?: string;
    capturedCategoryAudience: CapturedCategoryAudience | null;
  }> = [];
  let skipped = 0;

  for (const task of params.tasks) {
    const taskId = String(task._id || "").trim();
    const workspaceId = String(task.workspaceId || "").trim();
    const conversationId = String(task.conversationId || "").trim();
    const directRecipientEmail = normalizeString(task.recipientEmail);

    if (!taskId || !workspaceId) {
      await markTaskSkipped(
        taskId,
        params.leaseId,
        "invalid_batch_task_payload"
      );
      skipped += 1;
      continue;
    }

    let conversation: ConversationSendShape | null = null;
    let capturedCategoryAudience: CapturedCategoryAudience | null = null;
    if (conversationId) {
      conversation = await loadConversationForTask({
        conversationId,
        workspaceId,
        channel: "email",
      });
      if (!conversation) {
        await markTaskSkipped(taskId, params.leaseId, "conversation_not_found");
        skipped += 1;
        continue;
      }
    }

    if (conversation) {
      const revalidation = await validateScenarioEligibilityForTask({
        task,
        conversation,
      });
      if (!revalidation.valid) {
        await markTaskSkipped(
          taskId,
          params.leaseId,
          revalidation.reason || "dynamic_revalidation_failed"
        );
        skipped += 1;
        continue;
      }
      capturedCategoryAudience = revalidation.capturedCategoryAudience || null;
    }

    if (!conversation) {
      const scenarioValidation = await validateScenarioEligibilityForTask({
        task,
      });
      if (!scenarioValidation.valid) {
        await markTaskSkipped(
          taskId,
          params.leaseId,
          scenarioValidation.reason || "scenario_validation_failed"
        );
        skipped += 1;
        continue;
      }
    }

    const recipientEmail =
      directRecipientEmail ||
      (conversation
        ? resolveEmailRecipientFromConversation(conversation)
        : null);
    if (!recipientEmail) {
      await markTaskSkipped(taskId, params.leaseId, "missing_email_recipient");
      skipped += 1;
      continue;
    }

    const templateKey = normalizeString(task.emailTemplateKey) as
      | "announcement"
      | "product_update"
      | "event_reminder";
    if (!templateKey) {
      await markTaskSkipped(taskId, params.leaseId, "missing_email_template");
      skipped += 1;
      continue;
    }

    validRequests.push({
      task,
      recipientEmail,
      templateKey,
      templateModel: task.emailTemplateModel || {},
      subjectOverride: normalizeString(task.emailSubjectOverride) || undefined,
      messageStream: normalizeString(task.emailMessageStream) || undefined,
      capturedCategoryAudience,
    });
  }

  if (validRequests.length === 0) {
    return {
      processed: params.tasks.length,
      completed: 0,
      retried: 0,
      failedTerminal: 0,
      skipped,
    };
  }

  const workspaceId = String(validRequests[0]?.task.workspaceId || "").trim();
  const capacity = await ensureCompanyConversationCapacity(
    supabaseAdmin,
    workspaceId
  );
  if (!capacity.allowed) {
    for (const request of validRequests) {
      await markTaskSkipped(
        String(request.task._id || "").trim(),
        params.leaseId,
        COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE
      );
    }
    return {
      processed: params.tasks.length,
      completed: 0,
      retried: 0,
      failedTerminal: 0,
      skipped: skipped + validRequests.length,
    };
  }

  const checkCapturedCategories = (requests: typeof validRequests) =>
    Promise.all(
      requests.map(async request => ({
        request,
        stillCurrent: request.capturedCategoryAudience
          ? await hasCapturedCurrentCategory({
              conversationId: String(request.task.conversationId || "").trim(),
              workspaceId: String(request.task.workspaceId || "").trim(),
              capturedCategoryAudience: request.capturedCategoryAudience,
            })
          : true,
      }))
    );

  const preliminaryChecks = await checkCapturedCategories(validRequests);
  const preliminaryReadyRequests: typeof validRequests = [];
  const preliminaryMisses: typeof validRequests = [];
  for (const check of preliminaryChecks) {
    (check.stillCurrent ? preliminaryReadyRequests : preliminaryMisses).push(
      check.request
    );
  }
  await Promise.all(
    preliminaryMisses.map(request =>
      markTaskSkipped(
        String(request.task._id || "").trim(),
        params.leaseId,
        "dynamic_category_changed_before_send"
      )
    )
  );
  skipped += preliminaryMisses.length;

  if (preliminaryReadyRequests.length === 0) {
    return {
      processed: params.tasks.length,
      completed: 0,
      retried: 0,
      failedTerminal: 0,
      skipped,
    };
  }

  const finalChecks = await checkCapturedCategories(preliminaryReadyRequests);
  const sendableRequests: typeof validRequests = [];
  const finalMisses: typeof validRequests = [];
  for (const check of finalChecks) {
    (check.stillCurrent ? sendableRequests : finalMisses).push(check.request);
  }
  skipped += finalMisses.length;

  if (sendableRequests.length === 0) {
    await Promise.all(
      finalMisses.map(request =>
        markTaskSkipped(
          String(request.task._id || "").trim(),
          params.leaseId,
          "dynamic_category_changed_before_send"
        )
      )
    );
    return {
      processed: params.tasks.length,
      completed: 0,
      retried: 0,
      failedTerminal: 0,
      skipped,
    };
  }

  const batchOutcome = await sendCampaignTransportBatch({
    channel: "email",
    workspaceId: String(sendableRequests[0]?.task.workspaceId || ""),
    messages: sendableRequests.map(item => ({
      recipient: { email: item.recipientEmail },
      templateKey: item.templateKey,
      templateModel: item.templateModel,
      subjectOverride: item.subjectOverride,
      messageStream: item.messageStream,
    })),
  })
    .then(result => ({ ok: true as const, result }))
    .catch(error => ({ ok: false as const, error }));

  const persistFinalMisses = () =>
    Promise.all(
      finalMisses.map(request =>
        markTaskSkipped(
          String(request.task._id || "").trim(),
          params.leaseId,
          "dynamic_category_changed_before_send"
        )
      )
    );
  if (!batchOutcome.ok) {
    await persistFinalMisses();
    throw batchOutcome.error;
  }
  const batchResult = batchOutcome.result;

  let completed = 0;
  let retried = 0;
  let failedTerminal = 0;

  for (let index = 0; index < sendableRequests.length; index += 1) {
    const request = sendableRequests[index];
    const result = batchResult.results[index];
    const taskId = String(request.task._id || "").trim();

    if (result?.success && result.messageId) {
      const owned = await persistSuccessfulDelivery({
        task: request.task,
        recipient: request.recipientEmail,
        provider: "postmark",
        messageId: result.messageId,
      });
      if (!owned) {
        await markTaskRetry({
          task: request.task,
          leaseId: params.leaseId,
          errorMessage: "campaign_message_sent_ledger_unconfirmed",
          now: params.now,
        });
        retried += 1;
        continue;
      }
      await markTaskCompleted(taskId, params.leaseId);
      completed += 1;
      continue;
    }

    const errorMessage =
      result?.error ||
      batchResult.error ||
      "Campaign email batch delivery failed";
    const failureStatus = await persistTerminalAttemptAndMaybeFail({
      task: request.task,
      leaseId: params.leaseId,
      errorMessage,
      providerCode: result?.providerCode,
      failureScope: result?.failureScope,
      now: params.now,
    });
    if (failureStatus === "failed_terminal") {
      failedTerminal += 1;
    } else {
      retried += 1;
    }
  }

  await persistFinalMisses();

  return {
    processed: params.tasks.length,
    completed,
    retried,
    failedTerminal,
    skipped,
  };
}

async function handleFailedClaimedTask(params: {
  task: CampaignDeliveryTaskRecord;
  leaseId: string;
  error: unknown;
  now: Date;
}) {
  if (
    params.task.channel === "whatsapp" &&
    params.task.providerAttemptStartedAt
  ) {
    return reconcileUnknownTaskProviderAcceptance(params);
  }
  const classification = classifyCampaignTransportFailure({
    error: params.error,
    provider: params.task.provider || "meta",
  });
  const errorMessage =
    params.error instanceof Error ? params.error.message : String(params.error);
  return persistTerminalAttemptAndMaybeFail({
    task: params.task,
    leaseId: params.leaseId,
    errorMessage,
    providerCode: classification.providerCode,
    failureScope: classification.failureScope,
    now: params.now,
  });
}

async function recoverStaleCampaignDeliveryTasks(params: {
  workspaceId: string;
  campaignId: string;
  now: Date;
}) {
  const staleCutoff = new Date(
    params.now.getTime() - CAMPAIGN_DELIVERY_STALE_PROCESSING_MINUTES * 60_000
  );
  const staleTaskQuery = {
    ...buildCampaignTaskScopeQuery(params),
    status: "processing",
    processingStartedAt: { $ne: null, $lte: staleCutoff },
  };
  const expiredResult = await CampaignDeliveryTask.updateMany(
    {
      ...staleTaskQuery,
      ...buildExpiredDispatchCondition(params.now),
    },
    {
      $set: {
        status: "skipped",
        completedAt: params.now,
        skipReason: "dispatch_expired",
        processingStartedAt: null,
        processingLeaseId: null,
        processingLeaseHeartbeatAt: null,
        lastError: null,
        wakeMethod: null,
        wakeMessageId: null,
        wakeScheduledFor: null,
        wakePublishedAt: null,
        wakeCancelledAt: params.now,
      },
    }
  );
  const retryResult = await CampaignDeliveryTask.updateMany(
    {
      ...staleTaskQuery,
      ...buildUnexpiredDispatchCondition(params.now),
    },
    {
      $set: {
        status: "retry",
        dispatchAt: params.now,
        processingStartedAt: null,
        processingLeaseId: null,
        processingLeaseHeartbeatAt: null,
        lastError: "Recovered stale campaign delivery task",
        wakeMethod: null,
        wakeMessageId: null,
        wakeScheduledFor: null,
        wakePublishedAt: null,
        wakeCancelledAt: params.now,
      },
    }
  );

  const expired = expiredResult.modifiedCount || 0;
  const retried = retryResult.modifiedCount || 0;
  return { expired, total: expired + retried };
}

async function expireDueCampaignDeliveryTasks(params: {
  workspaceId: string;
  campaignId: string;
  now: Date;
}) {
  const result = await CampaignDeliveryTask.updateMany(
    {
      ...buildCampaignTaskScopeQuery(params),
      status: { $in: ["pending", "retry"] },
      dispatchAt: { $lte: params.now },
      ...buildExpiredDispatchCondition(params.now),
    },
    {
      $set: {
        status: "skipped",
        completedAt: params.now,
        skipReason: "dispatch_expired",
        processingStartedAt: null,
        processingLeaseId: null,
        processingLeaseHeartbeatAt: null,
        lastError: null,
        wakeMethod: null,
        wakeMessageId: null,
        wakeScheduledFor: null,
        wakePublishedAt: null,
        wakeCancelledAt: params.now,
      },
    }
  );

  return result.modifiedCount || 0;
}

async function claimNextDueTask(params: {
  workspaceId: string;
  campaignId: string;
  now: Date;
  leaseId: string;
  campaignStartedAt?: Date;
}) {
  return CampaignDeliveryTask.findOneAndUpdate(
    {
      ...buildCampaignTaskScopeQuery(params),
      status: { $in: ["pending", "retry"] },
      dispatchAt: { $lte: params.now },
      ...buildUnexpiredDispatchCondition(params.now),
    },
    {
      $set: {
        status: "processing",
        processingStartedAt: params.now,
        processingLeaseId: params.leaseId,
        processingLeaseHeartbeatAt: params.now,
        ...(params.campaignStartedAt
          ? { campaignStartedAt: params.campaignStartedAt }
          : {}),
        lastError: null,
        wakeMethod: null,
        wakeMessageId: null,
        wakeScheduledFor: null,
        wakePublishedAt: null,
      },
      $inc: { attempts: 1 },
    },
    {
      new: true,
      sort: { dispatchAt: 1, _id: 1 },
    }
  ).lean<CampaignDeliveryTaskRecord | null>();
}

async function getPendingState(params: {
  workspaceId: string;
  campaignId: string;
}) {
  const query = {
    ...buildCampaignTaskScopeQuery(params),
    status: { $in: ["pending", "retry"] },
  };
  const [pendingCount, nextPendingTask] = await Promise.all([
    CampaignDeliveryTask.countDocuments(query),
    CampaignDeliveryTask.findOne(query)
      .sort({ dispatchAt: 1, _id: 1 })
      .select("dispatchAt")
      .lean<{ dispatchAt?: Date | string } | null>(),
  ]);

  const nextDispatchAt =
    nextPendingTask?.dispatchAt instanceof Date
      ? nextPendingTask.dispatchAt.toISOString()
      : typeof nextPendingTask?.dispatchAt === "string"
        ? nextPendingTask.dispatchAt
        : null;

  return {
    pendingCount,
    nextDispatchAt,
  };
}

function normalizeBatchLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) {
    return 20;
  }
  return Math.max(1, Math.min(500, parsed));
}

export async function drainCampaignDeliveryTasks(
  input: CampaignDeliveryDrainInput
): Promise<CampaignDeliveryDrainResult> {
  const workspaceId = normalizeString(input.workspaceId);
  const campaignId = normalizeString(input.campaignId);
  if (!workspaceId || !campaignId) {
    throw new Error("workspaceId and campaignId are required");
  }

  await connectDB();

  const now = new Date();
  const batchLimit = normalizeBatchLimit(input.batchLimit);
  const leaseId = createProcessingLeaseId();
  let campaignStarted = await markCampaignDeliveryStarted({
    workspaceId,
    campaignId,
    now,
  });
  const staleRecovery = await recoverStaleCampaignDeliveryTasks({
    workspaceId,
    campaignId,
    now,
  });
  const expiredDue = await expireDueCampaignDeliveryTasks({
    workspaceId,
    campaignId,
    now,
  });

  let processed = 0;
  let completed = 0;
  let retried = 0;
  let failedTerminal = 0;
  let skipped = staleRecovery.expired + expiredDue;

  while (processed < batchLimit) {
    const claimed = await claimNextDueTask({
      workspaceId,
      campaignId,
      now,
      leaseId,
      campaignStartedAt: campaignStarted ? undefined : now,
    });
    if (!claimed) {
      break;
    }

    if (!campaignStarted) {
      await propagateCampaignDeliveryStarted({
        workspaceId,
        campaignId,
        campaignStartedAt: resolveCampaignStartedAt(
          claimed.campaignStartedAt,
          now
        ),
      });
      campaignStarted = true;
    }

    if (
      claimed.channel === "email" &&
      claimed.deliveryMode === "batch" &&
      isCampaignEmailBatchEnabled()
    ) {
      const claimedBatchTasks = await claimEmailBatchTasks({
        leaderTask: claimed,
        now,
        leaseId,
        maxTasks: batchLimit - processed,
      });
      const batchResult = await processClaimedEmailBatch({
        tasks: claimedBatchTasks,
        leaseId,
        now,
      });
      processed += batchResult.processed;
      completed += batchResult.completed;
      retried += batchResult.retried;
      failedTerminal += batchResult.failedTerminal;
      skipped += batchResult.skipped;
      continue;
    }

    try {
      const result = await processClaimedTask({
        task: claimed,
        leaseId,
      });
      processed += 1;
      if (result.status === "completed") {
        completed += 1;
      } else if (
        result.status === "retry" ||
        result.status === "failed_terminal"
      ) {
        if (result.status === "failed_terminal") {
          failedTerminal += 1;
        } else {
          retried += 1;
        }
      } else {
        skipped += 1;
      }
    } catch (error) {
      const failureStatus = await handleFailedClaimedTask({
        task: claimed,
        leaseId,
        error,
        now,
      });
      processed += 1;
      if (failureStatus === "failed_terminal") {
        failedTerminal += 1;
      } else {
        retried += 1;
      }
    }
  }

  const pendingState = await getPendingState({
    workspaceId,
    campaignId,
  });

  return {
    processed,
    completed,
    retried,
    failedTerminal,
    skipped,
    recoveredStale: staleRecovery.total,
    pendingCount: pendingState.pendingCount,
    nextDispatchAt: pendingState.nextDispatchAt,
  };
}

export async function finalizeCampaignExecution(
  input: CampaignExecutionFinalizeInput
): Promise<void> {
  const workspaceId = normalizeString(input.workspaceId);
  const campaignId = normalizeString(input.campaignId);
  if (!workspaceId || !campaignId) {
    throw new Error("workspaceId and campaignId are required");
  }

  await connectDB();
  const statusRows = await CampaignDeliveryTask.aggregate<{
    _id: string;
    count: number;
    unresolvedProviderAcceptance?: number;
  }>([
    { $match: { workspaceId, campaignId } },
    {
      $group: {
        _id: "$status",
        count: { $sum: 1 },
        unresolvedProviderAcceptance: {
          $sum: {
            $cond: [
              { $eq: ["$skipReason", PROVIDER_ACCEPTANCE_UNKNOWN_REASON] },
              1,
              0,
            ],
          },
        },
      },
    },
  ]);
  const counts = new Map<string, number>();
  for (const row of statusRows) {
    if (Number(row.unresolvedProviderAcceptance || 0) > 0) {
      throw new Error("Campaign provider acceptance is unresolved");
    }
    const status = normalizeString(row._id);
    const count = Number(row.count);
    if (!status || !Number.isSafeInteger(count) || count < 0) {
      throw new Error("Campaign delivery task totals are malformed");
    }
    if (!CAMPAIGN_DELIVERY_TASK_STATUSES.has(status)) {
      throw new Error("Campaign delivery task status is unknown");
    }
    counts.set(status, count);
  }

  const unfinished =
    (counts.get("pending") || 0) +
    (counts.get("processing") || 0) +
    (counts.get("retry") || 0);
  if (unfinished > 0) {
    throw new Error("Campaign delivery tasks are not terminal");
  }

  const { data: campaign, error: campaignError } = await supabaseAdmin
    .from("campaign_history")
    .select("total_recipients")
    .eq("id", campaignId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (campaignError) {
    throw new Error(
      `Failed to read campaign recipient total: ${campaignError.message}`
    );
  }
  const totalRecipients = Number(campaign?.total_recipients);
  if (
    !campaign ||
    !Number.isSafeInteger(totalRecipients) ||
    totalRecipients < 0
  ) {
    throw new Error("Campaign recipient total is malformed");
  }

  const terminalTaskCount =
    (counts.get("completed") || 0) +
    (counts.get("failed_terminal") || 0) +
    (counts.get("skipped") || 0);
  if (terminalTaskCount !== totalRecipients) {
    throw new Error(
      "Campaign terminal task count does not match total recipients"
    );
  }

  const reconciliation = await reconcileLegacyCampaignSendTotals({
    workspaceId,
    campaignId,
    totals: {
      successfulSends: counts.get("completed") || 0,
      failedSends:
        (counts.get("failed_terminal") || 0) + (counts.get("skipped") || 0),
    },
  });
  if (!reconciliation.ok) {
    throw new Error(reconciliation.error);
  }
}
