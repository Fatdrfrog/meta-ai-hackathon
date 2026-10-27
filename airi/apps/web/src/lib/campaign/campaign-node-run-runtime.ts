import { buildCampaignAudienceQueryWithFollowUpPrediction } from "@/lib/campaign/campaign-audience-follow-up";
import {
  findBirthdayAudiencePage,
  type BirthdayAudienceRecipient,
} from "@/lib/campaign/campaign-birthday-audience";
import { normalizeCampaignTimezone } from "@/lib/campaign/campaign-schedule-config";
import { buildBirthdayCampaignOccurrence } from "@/lib/campaign/campaign-birthday-occurrence";
import {
  buildCampaignAudienceQueryDefinition,
  parseCampaignAudienceFilterParam,
  resolveFollowUpStatusesForBulkCampaign,
} from "@/lib/campaign/campaign-audience";
import {
  assertCampaignPlanSendingReadiness,
  resolveCampaignBatchPlan,
  resolveCampaignBatchPlanPreview,
  type CampaignRecipientLimit,
} from "@/lib/campaign/campaign-batch-plan";
import { getBulkCampaignDispatchExpiresAt } from "@/lib/campaign/bulk-campaign-safety";
import { isCampaignEmailBatchEnabled } from "@/lib/campaign/campaign-config";
import { buildCampaignDeliveryIdempotencyKey } from "@/lib/campaign/campaign-delivery";
import {
  createCampaignHistoryRecord,
  findCampaignHistoryRunReservation,
  updateCampaignHistoryRecipientCount,
} from "@/lib/campaign/campaign-history-store";
import { getCampaignTransportCapabilities } from "@/lib/campaign/campaign-transport";
import {
  buildCampaignWhatsappRecipientPayload,
  collectCampaignTemplateVariables,
  normalizeCampaignPhone,
  personalizeCampaignTelegramMessage,
  type CampaignSendTemplateComponent,
} from "@/lib/campaign/campaign-recipient-utils";
import {
  buildCampaignTemplateComponentsFromNode,
  getIncomingCampaignNodeIds,
  isSchedulableBuilderBirthdayRoot,
  isWhatsAppMarketingCampaignNode,
  normalizeCampaignScheduleType,
  resolveScheduledCampaignNode,
  resolveScheduledCampaignNodeChannel,
  type CampaignEdgeRecord,
  type CampaignNodeRecord,
  type CampaignScheduleType,
} from "@/lib/campaign/campaign-runtime-utils";
import {
  getWorkspaceEmailSource,
  resolveEmailProviderForWorkspaceSource,
} from "@/lib/email/email-source";
import {
  getWorkspaceEmailProviderConfig,
  isManagedEmailProviderPending,
} from "@/lib/email/provider-config";
import {
  COMPANY_BULK_CAMPAIGN_LIMIT_EXCEEDED_CODE,
  COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
  ensureCompanyConversationCapacity,
  getBulkRecipientsRemaining,
  type CompanySubscriptionType,
} from "@/lib/limits/company-limits";
import { PrebuiltEmailTemplateKey } from "@/lib/email/templates/registry";
import connectDB from "@/lib/mongoose";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveWhatsAppSendContext } from "@/lib/whatsapp/send-context";
import { resolveTelegramSendContext } from "@/lib/telegram/source-context";
import {
  isTelegramPrivateChatId,
  normalizeTelegramChatId,
} from "@/lib/telegram/chat-id";
import CampaignDeliveryTask from "@/models/campaign-delivery-task";
import { Conversation } from "@/models/conversation";
import { Scenario } from "@/models/scenario";
import type { CampaignNodeRunActivityResult } from "@icecore/temporal";
import type {
  BulkCampaignDispatchExecutionSource,
  BulkCampaignEligibilityMessageIntent,
  BulkCampaignRecipientPolicy,
} from "@icecore/scenario-contracts";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import { Types } from "mongoose";
import { MAX_BULK_CAMPAIGN_RECIPIENTS } from "./bulk-campaign-contracts";
import type { BulkCampaignRecipient } from "./bulk-campaign-contracts";
import { accumulateBulkCampaignEligibilityOutcome } from "./bulk-campaign-outcome";
import { emitBulkCampaignPolicyEvent } from "./bulk-campaign-observability";
import {
  readVerifiedBulkCampaignScenarioScheduleContext,
  routeVerifiedBulkCampaignScenarioScheduleProvenance,
  verifyBulkCampaignScenarioScheduleCapability,
  type VerifiedBulkCampaignRoute,
  type VerifiedBulkCampaignScenarioScheduleCapability,
} from "./bulk-campaign-provenance";
import { resolveMinimumBulkCampaignPlan } from "./bulk-campaign-recipient-eligibility";
import {
  hashBulkCampaignRecipientIdentity,
  canonicalizeBulkCampaignRecipientIdentity,
} from "./bulk-campaign-safety";
import {
  evaluateBulkRecipientPolicy,
  type BulkRecipientPolicyEvaluation,
  type BulkRecipientPolicyInput,
} from "./bulk-recipient-policy";
import {
  resolveEmailRecipientFromConversation,
  resolveRecipientFromConversation,
} from "./dispatch-recipients";
import { createServerLogger } from "@/lib/observability/server-logs";

type BulkScenarioRecord = {
  _id: Types.ObjectId;
  workspaceId: string;
  name?: string;
  mode?: string;
  status?: string;
  timezone?: string;
  nodes?: CampaignNodeRecord[];
  edges?: CampaignEdgeRecord[];
  bulkFollowUpSettings?: unknown;
  createdBy?: string;
  updatedBy?: string;
};

export type CampaignNodeRunRuntimeInput = {
  workspaceId: string;
  scenarioId: string;
  nodeId: string;
  scheduledFor?: string | null;
  scheduleId?: string | null;
  executionSource?: BulkCampaignDispatchExecutionSource;
  forceShadow?: boolean;
  ignoreExistingDeliveryTasks?: boolean;
};

const COMPLETE_OCCURRENCE_SENTINEL_LIMIT = MAX_BULK_CAMPAIGN_RECIPIENTS + 1;
const DELIVERY_TASK_BULK_WRITE_CHUNK_SIZE = 500;
const campaignNodeRunLogger = createServerLogger("campaign-node-run");

export class RecurringBulkRecipientPolicyUnsupportedError extends Error {
  readonly code = "bulk_recipient_policy_unsupported" as const;

  constructor() {
    super(
      "The persisted recurring recipient policy requires a verified WhatsApp template capability"
    );
    this.name = "RecurringBulkRecipientPolicyUnsupportedError";
  }
}

type ConversationAudienceRow = {
  _id?: unknown;
  user?: unknown;
  chat?: unknown;
  sourceId?: unknown;
  participants?: { from?: unknown; to?: unknown };
  channel?: unknown;
};

type OccurrenceDispatchItem = {
  stableId: string;
  recipientId: string;
  conversationId: string | null;
  recipient: BulkCampaignRecipient;
  sourceId: string | null;
  name?: string | null;
  variables?: Record<string, string>;
  birthdayRecipient?: BirthdayAudienceRecipient;
};

export type CampaignNodeRunRuntimeDependencies = {
  findAudiencePage?(params: {
    query: Record<string, unknown>;
    sort: Record<string, 1>;
    limit: number;
    select: string;
  }): Promise<ConversationAudienceRow[]>;
  evaluateRecipientPolicy?<T>(
    input: BulkRecipientPolicyInput<T>
  ): Promise<BulkRecipientPolicyEvaluation<T>>;
  bulkWrite?(
    operations: unknown[],
    options?: { ordered?: boolean }
  ): Promise<{ upsertedCount?: number }>;
  findBirthdayAudiencePage?: typeof findBirthdayAudiencePage;
  verifyScheduleCapability?: typeof verifyBulkCampaignScenarioScheduleCapability;
  routeScheduleProvenance?: typeof routeVerifiedBulkCampaignScenarioScheduleProvenance;
  readScheduleContext?: typeof readVerifiedBulkCampaignScenarioScheduleContext;
  resolvePlan?: typeof resolveCampaignBatchPlanPreview;
};

async function defaultFindAudiencePage(params: {
  query: Record<string, unknown>;
  sort: Record<string, 1>;
  limit: number;
  select: string;
}): Promise<ConversationAudienceRow[]> {
  return Conversation.find(params.query)
    .sort(params.sort)
    .limit(params.limit)
    .select(params.select)
    .lean<ConversationAudienceRow[]>();
}

function buildScheduleMessageIntent(params: {
  channel: "whatsapp" | "telegram" | "email";
  nodeData: Record<string, unknown>;
  sourceId: string;
}): BulkCampaignEligibilityMessageIntent {
  if (params.channel === "whatsapp") {
    return {
      kind: "whatsapp_template",
      sourceId: params.sourceId,
      templateName: String(
        params.nodeData.templateName ||
          params.nodeData.actionWhatsAppTemplateName ||
          ""
      ).trim(),
      language: String(
        params.nodeData.templateLanguage ||
          params.nodeData.actionWhatsAppTemplateLanguage ||
          "en"
      ).trim(),
    };
  }
  return { kind: "unsupported", messageKind: params.channel };
}

function resolveOccurrenceRecipientIdentity(params: {
  channel: "whatsapp" | "telegram" | "email";
  conversation: ConversationAudienceRow;
}): { recipient: BulkCampaignRecipient; recipientId: string } | null {
  const sourceId = String(params.conversation.sourceId || "").trim() || null;
  if (params.channel === "whatsapp") {
    const phone = resolveRecipientFromConversation(params.conversation);
    const normalized = normalizeCampaignPhone(phone || "");
    if (!normalized) return null;
    return {
      recipient: { phone: normalized, ...(sourceId ? { sourceId } : {}) },
      recipientId: String(params.conversation._id || "").trim(),
    };
  }
  if (params.channel === "telegram") {
    const chatId = normalizeTelegramChatId(params.conversation.chat);
    if (!isTelegramPrivateChatId(chatId)) return null;
    return {
      recipient: { chatId, ...(sourceId ? { sourceId } : {}) },
      recipientId: chatId,
    };
  }
  const email = resolveEmailRecipientFromConversation(params.conversation);
  if (!email) return null;
  return {
    recipient: { email },
    recipientId: String(params.conversation._id || "").trim(),
  };
}

function resolveBirthdayOccurrenceIdentity(params: {
  channel: "whatsapp" | "telegram" | "email";
  recipient: BirthdayAudienceRecipient;
}): { recipient: BulkCampaignRecipient; recipientId: string } | null {
  const sourceId = String(params.recipient.sourceId || "").trim() || null;
  if (params.channel === "whatsapp") {
    const normalized = normalizeCampaignPhone(params.recipient.phone || "");
    if (!normalized) return null;
    return {
      recipient: { phone: normalized, ...(sourceId ? { sourceId } : {}) },
      recipientId: normalized,
    };
  }
  if (params.channel === "telegram") {
    const chatId = normalizeTelegramChatId(params.recipient.chatId);
    if (!isTelegramPrivateChatId(chatId)) return null;
    return {
      recipient: { chatId, ...(sourceId ? { sourceId } : {}) },
      recipientId: chatId,
    };
  }
  return null;
}

/** The routed step's saved template, when birthday taps name that step. */
function resolveBirthdayStepTemplate(
  route: VerifiedBulkCampaignRoute | undefined,
  messageActionNodeId: string
): VerifiedBulkCampaignRoute["stepTemplate"] {
  return route?.actionNodeId === messageActionNodeId
    ? route.stepTemplate
    : undefined;
}

function hashOccurrenceRecipient(params: {
  secret: string;
  workspaceId: string;
  channel: "whatsapp" | "telegram" | "email";
  recipient: BulkCampaignRecipient;
}): string | null {
  const identity = canonicalizeBulkCampaignRecipientIdentity({
    channel: params.channel,
    recipient: params.recipient,
  });
  if (!identity) return null;
  return hashBulkCampaignRecipientIdentity({
    secret: params.secret,
    workspaceId: params.workspaceId,
    channel: params.channel,
    identity,
  });
}

function assertCompleteOccurrenceCapacity(params: {
  items: number;
  uniqueIdentities: number;
}): void {
  if (
    params.items >= COMPLETE_OCCURRENCE_SENTINEL_LIMIT ||
    params.uniqueIdentities >= COMPLETE_OCCURRENCE_SENTINEL_LIMIT
  ) {
    throw new Error("bulk_campaign_occurrence_hard_cap_exceeded");
  }
}

function chunkOperations<T>(operations: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < operations.length; index += size) {
    chunks.push(operations.slice(index, index + size));
  }
  return chunks;
}

function parseBooleanValue(value: unknown): boolean {
  return (
    value === true ||
    (typeof value === "string" && value.trim().toLowerCase() === "true")
  );
}

function resolveNodeScheduleTimezone(params: {
  nodeData: Record<string, unknown>;
  scenarioTimezone?: unknown;
}): string {
  const scheduleConfig =
    params.nodeData.scheduleConfig &&
    typeof params.nodeData.scheduleConfig === "object" &&
    !Array.isArray(params.nodeData.scheduleConfig)
      ? (params.nodeData.scheduleConfig as Record<string, unknown>)
      : null;
  return normalizeCampaignTimezone(
    scheduleConfig?.timezone || params.scenarioTimezone
  );
}

function normalizePayload(
  input: CampaignNodeRunRuntimeInput | null | undefined
): Required<
  Pick<CampaignNodeRunRuntimeInput, "workspaceId" | "scenarioId" | "nodeId">
> & {
  executionSource: BulkCampaignDispatchExecutionSource;
  scheduledFor: string | null;
  scheduleId: string | null;
  forceShadow: boolean;
  ignoreExistingDeliveryTasks: boolean;
} {
  const scheduledFor =
    typeof input?.scheduledFor === "string" && input.scheduledFor.trim()
      ? input.scheduledFor.trim()
      : null;
  const scheduleId =
    typeof input?.scheduleId === "string" && input.scheduleId.trim()
      ? input.scheduleId.trim()
      : null;
  return {
    workspaceId: String(input?.workspaceId || "").trim(),
    scenarioId: String(input?.scenarioId || "").trim(),
    nodeId: String(input?.nodeId || "").trim(),
    scheduledFor,
    scheduleId,
    executionSource:
      input?.executionSource === "scenario_run_now" ||
      input?.executionSource === "ad_hoc"
        ? input.executionSource
        : "scenario_schedule",
    forceShadow: parseBooleanValue(input?.forceShadow),
    ignoreExistingDeliveryTasks: parseBooleanValue(
      input?.ignoreExistingDeliveryTasks
    ),
  };
}

function getNodeRunKey(params: {
  scheduleType: CampaignScheduleType;
  now: Date;
  timezone: string;
  day?: unknown;
  time?: unknown;
  scheduledFor?: string | null;
}): string {
  if (params.scheduledFor) {
    return `scheduled:${params.scheduledFor}`;
  }

  if (params.scheduleType === "relative") {
    return `relative:${Math.floor(params.now.getTime() / (5 * 60_000))}`;
  }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: params.timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const dateKey = formatter.format(params.now);
  return `weekly:${params.timezone}:${dateKey}:${String(params.day || "")}:${String(params.time || "")}`;
}

function resolveNextInternalLabel(
  nodeId: string,
  nodes: CampaignNodeRecord[],
  edges: CampaignEdgeRecord[]
): string | null {
  const edge = edges.find(item => String(item.source || "") === nodeId);
  if (!edge?.target) return null;
  const nextNode = nodes.find(item => String(item.id) === String(edge.target));
  const nextLabel = String(nextNode?.data?.internalLabel || "").trim();
  return nextLabel || null;
}

type CampaignNodeRunDeliveryIdentity = {
  idempotencyKey: string;
};

function buildCampaignNodeRunDeliveryIdentity(params: {
  scenarioId: string;
  nodeId: string;
  executionSource: BulkCampaignDispatchExecutionSource;
  recipientId: string;
  runKey: string;
}): CampaignNodeRunDeliveryIdentity {
  return {
    idempotencyKey: buildCampaignDeliveryIdempotencyKey([
      params.scenarioId,
      params.nodeId,
      params.recipientId,
      params.runKey,
    ]),
  };
}

function buildCampaignNodeRunDeliveryFilter(
  identity: CampaignNodeRunDeliveryIdentity,
  executionSource: BulkCampaignDispatchExecutionSource
) {
  return {
    idempotencyKey: identity.idempotencyKey,
    executionSource,
  };
}

async function countExistingDeliveryIdentities(params: {
  identities: CampaignNodeRunDeliveryIdentity[];
  executionSource: BulkCampaignDispatchExecutionSource;
}) {
  if (params.identities.length === 0) return 0;
  const existing = await CampaignDeliveryTask.find({
    idempotencyKey: {
      $in: params.identities.map(identity => identity.idempotencyKey),
    },
    executionSource: params.executionSource,
  })
    .select("idempotencyKey")
    .lean<Array<{ idempotencyKey?: string }>>();
  return existing.length;
}

type ExistingCampaignTask = {
  campaignId?: string | null;
  runKey?: string | null;
};

function buildCampaignNodeRunTaskScope(params: {
  workspaceId: string;
  scenarioId: string;
  nodeId: string;
  runKey: string;
  executionSource: BulkCampaignDispatchExecutionSource;
}) {
  return {
    workspaceId: params.workspaceId,
    scenarioId: params.scenarioId,
    nodeId: params.nodeId,
    runKey: params.runKey,
    executionSource: params.executionSource,
  };
}

async function findExistingCampaignIdForNodeRun(params: {
  workspaceId: string;
  scenarioId: string;
  nodeId: string;
  runKey: string;
  executionSource: BulkCampaignDispatchExecutionSource;
  legacyScheduledForRange?: { start: string; end: string };
}): Promise<{ campaignId: string; runKey: string } | null> {
  const task = await CampaignDeliveryTask.findOne({
    ...buildCampaignNodeRunTaskScope(params),
    ...(params.legacyScheduledForRange
      ? {
          runKey: {
            $gte: `scheduled:${params.legacyScheduledForRange.start}`,
            $lt: `scheduled:${params.legacyScheduledForRange.end}`,
          },
        }
      : {}),
    campaignId: { $type: "string", $ne: "" },
  })
    .select("campaignId runKey")
    .lean<ExistingCampaignTask | null>();
  const campaignId = String(task?.campaignId || "").trim();
  if (!campaignId) return null;
  const runKey = String(task?.runKey || params.runKey).trim();
  if (
    params.legacyScheduledForRange &&
    (runKey < `scheduled:${params.legacyScheduledForRange.start}` ||
      runKey >= `scheduled:${params.legacyScheduledForRange.end}`)
  )
    throw new Error("Legacy birthday task run identity is malformed");
  return { campaignId, runKey };
}

async function getCampaignNodeRunTaskCounts(params: {
  workspaceId: string;
  scenarioId: string;
  nodeId: string;
  runKey: string;
  campaignId: string;
  executionSource: BulkCampaignDispatchExecutionSource;
}) {
  const scope = {
    ...buildCampaignNodeRunTaskScope(params),
    campaignId: params.campaignId,
  };
  const [total, pending] = await Promise.all([
    CampaignDeliveryTask.countDocuments(scope),
    CampaignDeliveryTask.countDocuments({
      ...scope,
      status: { $in: ["pending", "retry"] },
    }),
  ]);
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !Number.isSafeInteger(pending) ||
    pending < 0 ||
    pending > total
  ) {
    throw new Error("Campaign delivery task counts are malformed");
  }
  return { total, pending };
}

function buildSkippedResult(
  payload: ReturnType<typeof normalizePayload>,
  reason: string
): CampaignNodeRunActivityResult {
  return {
    status: "skipped",
    shadowMode: false,
    scenarioId: payload.scenarioId,
    nodeId: payload.nodeId,
    deliveryRuntime: "campaign_delivery",
    candidates: 0,
    created: 0,
    wouldCreate: 0,
    pendingCount: 0,
    reason,
  };
}

function resolveBirthdayAudiencePhones(
  nodeData: Record<string, unknown>
): string[] {
  const rows = Array.isArray(nodeData.uploadedRecipients)
    ? nodeData.uploadedRecipients
    : [];
  return Array.from(
    new Set(
      rows
        .map(row =>
          row && typeof row === "object"
            ? normalizeCampaignPhone(
                String((row as { phone?: unknown }).phone || "")
              )
            : ""
        )
        .filter(Boolean)
    )
  );
}

function resolveBirthdayAudienceChatIds(
  nodeData: Record<string, unknown>
): string[] {
  const rows = Array.isArray(nodeData.uploadedRecipients)
    ? nodeData.uploadedRecipients
    : [];
  return Array.from(
    new Set(
      rows
        .map(row =>
          row && typeof row === "object"
            ? normalizeTelegramChatId((row as { chatId?: unknown }).chatId)
            : ""
        )
        .filter(isTelegramPrivateChatId)
    )
  );
}

function normalizeRunRecipientLimit(
  recipientLimit?: CampaignRecipientLimit | null
): number | null {
  const maxRecipients = recipientLimit?.maxRecipients;
  return typeof maxRecipients === "number" &&
    Number.isFinite(maxRecipients) &&
    maxRecipients > 0
    ? Math.floor(maxRecipients)
    : null;
}

export async function executeCampaignNodeRun(
  input: CampaignNodeRunRuntimeInput,
  dependencies: CampaignNodeRunRuntimeDependencies = {}
): Promise<CampaignNodeRunActivityResult> {
  const payload = normalizePayload(input);

  if (
    !payload.workspaceId ||
    !payload.scenarioId ||
    !payload.nodeId ||
    !Types.ObjectId.isValid(payload.scenarioId)
  ) {
    throw new Error("Missing or invalid workspaceId, scenarioId, or nodeId");
  }

  await connectDB();
  const now = new Date();
  const parsedScheduledForDate = payload.scheduledFor
    ? new Date(payload.scheduledFor)
    : null;
  const scheduledForDate =
    parsedScheduledForDate && Number.isFinite(parsedScheduledForDate.getTime())
      ? parsedScheduledForDate
      : null;
  const effectiveNow = scheduledForDate || now;
  const dispatchExpiresAt = new Date(
    getBulkCampaignDispatchExpiresAt({ requestedAt: effectiveNow })
  );
  const scheduledForIso = scheduledForDate
    ? scheduledForDate.toISOString()
    : null;
  const stableRunKey = scheduledForIso ? `scheduled:${scheduledForIso}` : null;
  const shadowMode = payload.forceShadow;
  let preloadedTaskCampaignId: string | null = null;
  let preloadedHistoryReservation: Awaited<
    ReturnType<typeof findCampaignHistoryRunReservation>
  > = null;
  if (!shadowMode && stableRunKey) {
    const [preloadedTask, reservation] = await Promise.all([
      findExistingCampaignIdForNodeRun({
        workspaceId: payload.workspaceId,
        scenarioId: payload.scenarioId,
        nodeId: payload.nodeId,
        runKey: stableRunKey,
        executionSource: payload.executionSource,
      }),
      findCampaignHistoryRunReservation({
        supabase: supabaseAdmin,
        workspaceId: payload.workspaceId,
        scenarioId: payload.scenarioId,
        scenarioNodeId: payload.nodeId,
        executionSource: payload.executionSource,
        executionRunKey: stableRunKey,
      }),
    ]);
    preloadedTaskCampaignId = preloadedTask?.campaignId || null;
    preloadedHistoryReservation = reservation;
  }

  const reconcileProvisionalReservation = async (params: {
    runKey: string;
    taskCampaignId: string | null;
    reservation: Awaited<ReturnType<typeof findCampaignHistoryRunReservation>>;
  }) => {
    const reservation = params.reservation;
    if (!reservation?.bulkQuotaReservedAt) return;
    if (
      params.taskCampaignId &&
      params.taskCampaignId !== reservation.campaignId
    ) {
      throw new Error(
        "Campaign run identity conflicts between history and delivery tasks"
      );
    }
    const taskCounts = params.taskCampaignId
      ? await getCampaignNodeRunTaskCounts({
          workspaceId: payload.workspaceId,
          scenarioId: payload.scenarioId,
          nodeId: payload.nodeId,
          runKey: params.runKey,
          campaignId: reservation.campaignId,
          executionSource: payload.executionSource,
        })
      : { total: 0, pending: 0 };
    await updateCampaignHistoryRecipientCount({
      supabase: supabaseAdmin,
      workspaceId: payload.workspaceId,
      campaignId: reservation.campaignId,
      channel: reservation.channel,
      totalRecipients: taskCounts.total,
      scenarioId: payload.scenarioId,
      scenarioNodeId: payload.nodeId,
      executionSource: payload.executionSource,
      executionRunKey: params.runKey,
    });
  };
  const reconcilePreloadedReservationBeforeSkip = async () => {
    if (!stableRunKey) return;
    await reconcileProvisionalReservation({
      runKey: stableRunKey,
      taskCampaignId: preloadedTaskCampaignId,
      reservation: preloadedHistoryReservation,
    });
  };

  // No mode filter: builder campaigns live in conversation-mode scenarios.
  const scenario = (await Scenario.findOne({
    _id: payload.scenarioId,
    workspaceId: payload.workspaceId,
    deletedAt: null,
  }).lean()) as BulkScenarioRecord | null;

  if (!scenario) {
    await reconcilePreloadedReservationBeforeSkip();
    throw new Error("Bulk scenario not found");
  }

  const nodes = Array.isArray(scenario.nodes) ? scenario.nodes : [];
  const edges = Array.isArray(scenario.edges) ? scenario.edges : [];
  const node = nodes.find(item => String(item.id) === payload.nodeId) || null;
  if (!node) {
    await reconcilePreloadedReservationBeforeSkip();
    throw new Error("Bulk scenario node not found");
  }

  // Builder scenarios schedule daily birthday roots. A stale
  // schedule on any other node is skipped rather than retried.
  const isBuilderScenario =
    String(scenario.mode || "").trim() !== "bulk_campaign";
  if (isBuilderScenario && !isSchedulableBuilderBirthdayRoot(node)) {
    await reconcilePreloadedReservationBeforeSkip();
    return buildSkippedResult(payload, "scheduled_node_not_campaign_root");
  }

  if (String(scenario.status || "").trim() !== "active") {
    await reconcilePreloadedReservationBeforeSkip();
    return buildSkippedResult(payload, "scenario_not_active");
  }

  const scheduledNode = resolveScheduledCampaignNode({
    node,
    nodes,
    edges,
  });
  if (!scheduledNode) {
    await reconcilePreloadedReservationBeforeSkip();
    return buildSkippedResult(payload, "missing_scheduled_campaign_template");
  }
  const nodeData = scheduledNode.data || {};
  const messageActionNodeId = scheduledNode.sourceNodeId || payload.nodeId;
  const scheduleType = normalizeCampaignScheduleType(nodeData.scheduleType);
  const channel = resolveScheduledCampaignNodeChannel(nodeData.channel);
  const timezone = resolveNodeScheduleTimezone({
    nodeData,
    scenarioTimezone: scenario.timezone,
  });
  if (!channel || (isBuilderScenario && channel === "email")) {
    await reconcilePreloadedReservationBeforeSkip();
    return buildSkippedResult(payload, "unsupported_scheduled_channel");
  }
  // Resolve the workspace source once so provenance and the send below agree
  // on it; a builder root without stored sourceIds sends from it.
  const whatsappSendContext =
    channel === "whatsapp"
      ? await resolveWhatsAppSendContext({ workspaceId: payload.workspaceId })
      : null;
  if (isBuilderScenario && channel === "whatsapp") {
    if (!whatsappSendContext?.sourceId) {
      await reconcilePreloadedReservationBeforeSkip();
      return buildSkippedResult(payload, "missing_whatsapp_credentials");
    }
    campaignNodeRunLogger.info("campaign_node_run.whatsapp_source", {
      workspaceId: payload.workspaceId,
      scenarioId: payload.scenarioId,
      nodeId: payload.nodeId,
      sourceId: whatsappSendContext.sourceId,
    });
  }
  if (
    isBuilderScenario &&
    channel === "telegram" &&
    !String(nodeData.telegramSourceId || "").trim()
  ) {
    await reconcilePreloadedReservationBeforeSkip();
    return buildSkippedResult(payload, "missing_telegram_source");
  }
  const audienceFilter = parseCampaignAudienceFilterParam(
    typeof nodeData.audienceFilter === "string" ? nodeData.audienceFilter : null
  );
  const targetingModeNorm = String(nodeData.targetingMode || "")
    .trim()
    .toLowerCase();
  const usesBirthdayAudience =
    audienceFilter === "birthday" && targetingModeNorm === "dynamic";
  const birthdayOccurrence = usesBirthdayAudience
    ? buildBirthdayCampaignOccurrence({ date: effectiveNow, timezone })
    : null;
  const verifyScheduleCapability =
    dependencies.verifyScheduleCapability ??
    verifyBulkCampaignScenarioScheduleCapability;
  const readScheduleContext =
    dependencies.readScheduleContext ??
    readVerifiedBulkCampaignScenarioScheduleContext;
  const routeScheduleProvenance =
    dependencies.routeScheduleProvenance ??
    routeVerifiedBulkCampaignScenarioScheduleProvenance;
  const scheduleCapability: VerifiedBulkCampaignScenarioScheduleCapability =
    await verifyScheduleCapability({
      workspaceId: payload.workspaceId,
      scenarioId: payload.scenarioId,
      scheduledNodeId: payload.nodeId,
      channel,
      messageIntent: buildScheduleMessageIntent({
        channel,
        nodeData,
        sourceId: whatsappSendContext?.sourceId || "",
      }),
    });
  const scheduleContext = readScheduleContext(scheduleCapability);
  const recipientPolicy: BulkCampaignRecipientPolicy =
    scheduleContext.recipientPolicy;
  let runKey =
    birthdayOccurrence?.runKey ||
    stableRunKey ||
    getNodeRunKey({
      scheduleType,
      now: effectiveNow,
      timezone,
      day: nodeData.day,
      time: nodeData.time,
      scheduledFor: scheduledForIso,
    });
  let existingCampaignId: string | null = null;
  let companyBulkCampaignLimit: number | null | undefined;
  let companySubscriptionType: CompanySubscriptionType | undefined;
  // Free bulk recipients left for a new run; null when unlimited or resumed.
  let bulkRecipientsRemaining: number | null = null;
  let taskCampaignId = preloadedTaskCampaignId;
  let historyReservation = preloadedHistoryReservation;
  if (!shadowMode) {
    if (birthdayOccurrence || !stableRunKey) {
      const [task, reservation] = await Promise.all([
        findExistingCampaignIdForNodeRun({
          workspaceId: payload.workspaceId,
          scenarioId: payload.scenarioId,
          nodeId: payload.nodeId,
          runKey,
          executionSource: payload.executionSource,
        }),
        findCampaignHistoryRunReservation({
          supabase: supabaseAdmin,
          workspaceId: payload.workspaceId,
          scenarioId: payload.scenarioId,
          scenarioNodeId: payload.nodeId,
          executionSource: payload.executionSource,
          executionRunKey: runKey,
        }),
      ]);
      taskCampaignId = task?.campaignId || null;
      historyReservation = reservation;
      if (birthdayOccurrence) {
        const legacyRange = {
          start: birthdayOccurrence.start,
          end: birthdayOccurrence.end,
        };
        const [legacyTask, legacyReservation] = await Promise.all([
          findExistingCampaignIdForNodeRun({
            workspaceId: payload.workspaceId,
            scenarioId: payload.scenarioId,
            nodeId: payload.nodeId,
            runKey,
            executionSource: payload.executionSource,
            legacyScheduledForRange: legacyRange,
          }),
          findCampaignHistoryRunReservation({
            supabase: supabaseAdmin,
            workspaceId: payload.workspaceId,
            scenarioId: payload.scenarioId,
            scenarioNodeId: payload.nodeId,
            executionSource: payload.executionSource,
            executionRunKey: runKey,
            legacyScheduledForRange: legacyRange,
          }),
        ]);
        const legacyCampaignId =
          legacyReservation?.campaignId || legacyTask?.campaignId;
        if (
          legacyTask &&
          legacyReservation &&
          legacyTask.campaignId !== legacyReservation.campaignId
        ) {
          throw new Error(
            "Birthday occurrence has conflicting legacy campaign identities"
          );
        }
        if (
          legacyCampaignId &&
          (taskCampaignId || historyReservation?.campaignId) &&
          legacyCampaignId !==
            (taskCampaignId || historyReservation?.campaignId)
        ) {
          throw new Error(
            "Birthday occurrence has conflicting campaign identities"
          );
        }
        if (legacyCampaignId) {
          runKey =
            legacyReservation?.executionRunKey ||
            legacyTask?.runKey ||
            stableRunKey ||
            runKey;
          taskCampaignId = legacyTask?.campaignId || null;
          historyReservation = legacyReservation;
        }
      }
    }
    const historyCampaignId = historyReservation?.campaignId || null;
    if (
      taskCampaignId &&
      historyCampaignId &&
      taskCampaignId !== historyCampaignId
    ) {
      throw new Error(
        "Campaign run identity conflicts between history and delivery tasks"
      );
    }
    if (historyReservation?.stopReason === "empty_audience") {
      if (taskCampaignId) {
        throw new Error(
          "Empty-audience campaign run unexpectedly has delivery tasks"
        );
      }
      return buildSkippedResult(payload, "empty_audience");
    }
    existingCampaignId = taskCampaignId || historyCampaignId;
  }
  const reconcileResolvedReservationBeforeSkip = async () => {
    if (shadowMode) return;
    await reconcileProvisionalReservation({
      runKey,
      taskCampaignId,
      reservation: historyReservation,
    });
  };

  if (!existingCampaignId) {
    const capacity = await ensureCompanyConversationCapacity(
      supabaseAdmin,
      payload.workspaceId,
      { includeBulkRecipientUsage: true }
    );
    if (!capacity.allowed) {
      return buildSkippedResult(
        payload,
        COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE
      );
    }
    companyBulkCampaignLimit = capacity.limit.bulkRecipientLimit;
    companySubscriptionType = capacity.limit.subscriptionType;
    bulkRecipientsRemaining = getBulkRecipientsRemaining(capacity.limit);
    if (bulkRecipientsRemaining === 0) {
      return buildSkippedResult(
        payload,
        COMPANY_BULK_CAMPAIGN_LIMIT_EXCEEDED_CODE
      );
    }
  }

  const provider = getCampaignTransportCapabilities(channel).provider;
  const useEmailBatchDelivery =
    channel === "email" && isCampaignEmailBatchEnabled();
  const templateName = String(nodeData.templateName || "").trim();
  const telegramMessageText = String(
    nodeData.messageText || nodeData.actionReplyText || ""
  ).trim();
  let telegramSourceId = String(nodeData.telegramSourceId || "").trim();
  const emailTemplateKey = String(nodeData.templateKey || "").trim();
  const supportedEmailTemplateKeys = new Set<PrebuiltEmailTemplateKey>([
    "announcement",
    "product_update",
    "event_reminder",
  ]);

  let batchPlan = undefined;
  let campaignRecipientLimit: CampaignRecipientLimit | null = null;
  if (channel === "whatsapp") {
    if (!templateName) {
      await reconcileResolvedReservationBeforeSkip();
      throw new Error("Missing WhatsApp templateName");
    }

    const sendContext = whatsappSendContext;
    if (!sendContext) {
      await reconcileResolvedReservationBeforeSkip();
      return buildSkippedResult(payload, "missing_whatsapp_credentials");
    }

    const campaignPlanPreview = await resolveCampaignBatchPlanPreview({
      channel,
      wabaId: sendContext.wabaId,
      phoneNumberId: sendContext.phoneNumberId,
      accessToken: sendContext.accessToken,
    });
    if (!existingCampaignId && !shadowMode) {
      assertCampaignPlanSendingReadiness(campaignPlanPreview);
    }
    batchPlan = campaignPlanPreview.batchPlan;
    campaignRecipientLimit = campaignPlanPreview.recipientLimit;
  } else if (channel === "telegram") {
    if (!telegramMessageText) {
      await reconcileResolvedReservationBeforeSkip();
      return buildSkippedResult(payload, "missing_telegram_message");
    }
    const sendContext = await resolveTelegramSendContext({
      workspaceId: payload.workspaceId,
      sourceId: telegramSourceId,
    });
    if (!sendContext) {
      await reconcileResolvedReservationBeforeSkip();
      return buildSkippedResult(payload, "missing_telegram_credentials");
    }
    telegramSourceId = sendContext.sourceId;
    const campaignPlanPreview = await resolveCampaignBatchPlanPreview({
      channel,
    });
    batchPlan = campaignPlanPreview.batchPlan;
    campaignRecipientLimit = campaignPlanPreview.recipientLimit;
  } else if (
    !supportedEmailTemplateKeys.has(
      emailTemplateKey as PrebuiltEmailTemplateKey
    )
  ) {
    await reconcileResolvedReservationBeforeSkip();
    throw new Error(`Unsupported email templateKey ${emailTemplateKey}`);
  } else {
    const emailSource = await getWorkspaceEmailSource(payload.workspaceId);
    const emailProvider =
      (await resolveEmailProviderForWorkspaceSource(emailSource)) ||
      (await getWorkspaceEmailProviderConfig(payload.workspaceId, true));
    if (!emailProvider) {
      await reconcileResolvedReservationBeforeSkip();
      return buildSkippedResult(payload, "missing_email_provider");
    }
    if (isManagedEmailProviderPending(emailProvider)) {
      await reconcileResolvedReservationBeforeSkip();
      return buildSkippedResult(payload, "email_provider_verification_pending");
    }
    if (emailProvider.status !== "active") {
      await reconcileResolvedReservationBeforeSkip();
      return buildSkippedResult(payload, "email_provider_inactive");
    }

    batchPlan = await resolveCampaignBatchPlan({ channel });
  }

  const scenarioObjectId =
    scenario._id instanceof Types.ObjectId
      ? scenario._id
      : new Types.ObjectId(scenario._id);
  const followUpIncludeWaiting =
    nodeData.followUpIncludeWaitingTimeout === true ||
    String(nodeData.followUpIncludeWaitingTimeout || "")
      .trim()
      .toLowerCase() === "true";

  const usesDynamicFollowUpAudience =
    audienceFilter === "follow_up_prediction" &&
    targetingModeNorm === "dynamic";

  if (usesBirthdayAudience && channel === "email") {
    await reconcileResolvedReservationBeforeSkip();
    return buildSkippedResult(payload, "unsupported_birthday_channel");
  }
  const birthdayAudiencePhones = usesBirthdayAudience
    ? resolveBirthdayAudiencePhones(nodeData)
    : [];
  const birthdayAudienceChatIds = usesBirthdayAudience
    ? resolveBirthdayAudienceChatIds(nodeData)
    : [];
  const selectedBirthdayRecipientCount =
    channel === "telegram"
      ? birthdayAudienceChatIds.length
      : birthdayAudiencePhones.length;
  if (usesBirthdayAudience && selectedBirthdayRecipientCount === 0) {
    await reconcileResolvedReservationBeforeSkip();
    return buildSkippedResult(payload, "missing_birthday_recipients");
  }
  const birthdayDailyRecipientLimit = usesBirthdayAudience
    ? normalizeRunRecipientLimit(campaignRecipientLimit)
    : null;
  if (usesBirthdayAudience && !birthdayDailyRecipientLimit) {
    await reconcileResolvedReservationBeforeSkip();
    return buildSkippedResult(payload, "missing_birthday_recipient_limit");
  }

  let audienceSource: "explicit" | "dynamic" | "birthday" = "dynamic";
  let query: Record<string, unknown> | null = null;
  if (usesBirthdayAudience) {
    audienceSource = "birthday";
  } else {
    const audienceDefinition = usesDynamicFollowUpAudience
      ? await buildCampaignAudienceQueryWithFollowUpPrediction({
          workspaceId: scenario.workspaceId,
          channel,
          templateCategory: isWhatsAppMarketingCampaignNode(nodeData)
            ? "MARKETING"
            : undefined,
          scheduleType,
          delayDays: nodeData.delayDays,
          now: effectiveNow,
          incomingNodeIds: getIncomingCampaignNodeIds(edges, payload.nodeId),
          scenarioId: scenarioObjectId,
          nodeId: payload.nodeId,
          followUpStatuses: resolveFollowUpStatusesForBulkCampaign({
            includeWaitingTimeout: followUpIncludeWaiting,
          }),
          bypassFollowUpCache: false,
        })
      : buildCampaignAudienceQueryDefinition({
          workspaceId: scenario.workspaceId,
          channel,
          targetingMode: nodeData.targetingMode,
          selectedConversationIds: Array.isArray(
            nodeData.selectedConversationIds
          )
            ? nodeData.selectedConversationIds
            : [],
          category: nodeData.category,
          internalLabel: nodeData.internalLabel,
          templateCategory: isWhatsAppMarketingCampaignNode(nodeData)
            ? "MARKETING"
            : undefined,
          scheduleType,
          delayDays: nodeData.delayDays,
          now: effectiveNow,
          incomingNodeIds: getIncomingCampaignNodeIds(edges, payload.nodeId),
          scenarioId: scenarioObjectId,
          nodeId: payload.nodeId,
        });
    audienceSource = audienceDefinition.audienceSource;

    if (audienceDefinition.skipReason) {
      await reconcileResolvedReservationBeforeSkip();
      return buildSkippedResult(payload, audienceDefinition.skipReason);
    }

    query = audienceDefinition.eligibleQuery;
  }
  const ignoreExistingDeliveryTasks = payload.ignoreExistingDeliveryTasks;
  const nextInternalLabel = resolveNextInternalLabel(
    messageActionNodeId,
    nodes,
    edges
  );
  const emailTemplateModel =
    nodeData.templateModel &&
    typeof nodeData.templateModel === "object" &&
    !Array.isArray(nodeData.templateModel)
      ? (nodeData.templateModel as Record<string, string>)
      : nodeData.templateVariables &&
          typeof nodeData.templateVariables === "object" &&
          !Array.isArray(nodeData.templateVariables)
        ? (nodeData.templateVariables as Record<string, string>)
        : {};
  const emailSubjectOverride = String(nodeData.subjectOverride || "").trim();
  const emailMessageStream = String(nodeData.messageStream || "").trim();
  const templateLanguage =
    String(nodeData.templateLanguage || "en").trim() || "en";
  const templateComponents = buildCampaignTemplateComponentsFromNode(nodeData);
  const rawWhatsappTemplateComponents =
    channel === "whatsapp" && Array.isArray(nodeData.templateComponents)
      ? (nodeData.templateComponents as WhatsAppComponent[])
      : undefined;
  const requiredTemplateVariables =
    channel === "whatsapp"
      ? collectCampaignTemplateVariables(rawWhatsappTemplateComponents)
      : [];
  const normalizedTemplateCategory = String(nodeData.templateCategory || "")
    .trim()
    .toUpperCase();
  const whatsappTemplateCategory =
    channel === "whatsapp" &&
    (normalizedTemplateCategory === "MARKETING" ||
      normalizedTemplateCategory === "UTILITY" ||
      normalizedTemplateCategory === "AUTHENTICATION")
      ? normalizedTemplateCategory
      : null;

  const birthdayPageSize = 500;
  const findAudiencePage =
    dependencies.findAudiencePage ?? defaultFindAudiencePage;
  const evaluateRecipientPolicy =
    dependencies.evaluateRecipientPolicy ?? evaluateBulkRecipientPolicy;
  const bulkWriteTasks =
    dependencies.bulkWrite ??
    ((operations: unknown[], options?: { ordered?: boolean }) =>
      CampaignDeliveryTask.bulkWrite(
        operations as Parameters<typeof CampaignDeliveryTask.bulkWrite>[0],
        { ordered: options?.ordered === true }
      ));
  const resolveBirthdayAudiencePage =
    dependencies.findBirthdayAudiencePage ?? findBirthdayAudiencePage;
  const resolvePlan =
    dependencies.resolvePlan ?? resolveCampaignBatchPlanPreview;

  let campaignId: string | null = existingCampaignId;
  let candidateCount = 0;
  let createdCount = 0;
  let wouldCreateCount = 0;

  const dispatchItems: OccurrenceDispatchItem[] = [];
  const uniqueIdentityKeys = new Set<string>();

  if (usesBirthdayAudience) {
    const birthdayChannel = channel === "telegram" ? "telegram" : "whatsapp";
    const eligibleBirthdayRecipientsById = new Map<
      string,
      BirthdayAudienceRecipient
    >();
    const selectedBirthdayRecipientIds =
      channel === "telegram" ? birthdayAudienceChatIds : birthdayAudiencePhones;
    let lastBirthdayCustomerId: string | null = null;

    while (true) {
      const page = await resolveBirthdayAudiencePage({
        workspaceId: payload.workspaceId,
        channel: birthdayChannel,
        scheduledFor: effectiveNow,
        timezone,
        birthdayConfig: nodeData.birthdayConfig,
        templateCategory: whatsappTemplateCategory,
        recipientPhones:
          channel === "whatsapp" ? birthdayAudiencePhones : undefined,
        recipientChatIds:
          channel === "telegram" ? birthdayAudienceChatIds : undefined,
        telegramSourceId: channel === "telegram" ? telegramSourceId : undefined,
        afterId: lastBirthdayCustomerId,
        limit: birthdayPageSize,
        ...(channel === "whatsapp" ? { deferMarketingPolicy: true } : {}),
      });
      candidateCount += Math.max(page.candidateCount, page.recipients.length);
      for (const recipient of page.recipients) {
        const recipientKey =
          channel === "telegram"
            ? normalizeTelegramChatId(recipient.chatId)
            : normalizeCampaignPhone(recipient.phone || "");
        if (recipientKey && !eligibleBirthdayRecipientsById.has(recipientKey)) {
          eligibleBirthdayRecipientsById.set(recipientKey, recipient);
        }
        const identity = resolveBirthdayOccurrenceIdentity({
          channel,
          recipient,
        });
        if (identity) {
          const canonical = canonicalizeBulkCampaignRecipientIdentity({
            channel,
            recipient: identity.recipient,
          });
          if (canonical) uniqueIdentityKeys.add(canonical);
        }
        assertCompleteOccurrenceCapacity({
          items: Math.max(
            candidateCount,
            eligibleBirthdayRecipientsById.size,
            uniqueIdentityKeys.size
          ),
          uniqueIdentities: uniqueIdentityKeys.size,
        });
      }
      assertCompleteOccurrenceCapacity({
        items: Math.max(
          candidateCount,
          eligibleBirthdayRecipientsById.size,
          uniqueIdentityKeys.size
        ),
        uniqueIdentities: uniqueIdentityKeys.size,
      });
      lastBirthdayCustomerId = page.nextCursor;
      if (!lastBirthdayCustomerId) break;
    }

    for (const recipientId of selectedBirthdayRecipientIds) {
      const recipient = eligibleBirthdayRecipientsById.get(recipientId);
      if (!recipient) continue;
      const identity = resolveBirthdayOccurrenceIdentity({
        channel,
        recipient,
      });
      if (!identity) continue;
      const canonical = canonicalizeBulkCampaignRecipientIdentity({
        channel,
        recipient: identity.recipient,
      });
      if (canonical) uniqueIdentityKeys.add(canonical);
      dispatchItems.push({
        stableId: identity.recipientId,
        recipientId: identity.recipientId,
        conversationId: null,
        recipient: identity.recipient,
        sourceId: identity.recipient.sourceId || null,
        name: recipient.name || null,
        birthdayRecipient: recipient,
      });
    }
  } else {
    if (!query) {
      return buildSkippedResult(payload, "missing_campaign_audience");
    }
    const conversations = await findAudiencePage({
      query,
      sort: { _id: 1 },
      limit: COMPLETE_OCCURRENCE_SENTINEL_LIMIT,
      select: "_id user chat sourceId participants channel",
    });
    candidateCount = conversations.length;
    for (const conversation of conversations) {
      const identity = resolveOccurrenceRecipientIdentity({
        channel,
        conversation,
      });
      if (!identity) continue;
      const conversationId = String(conversation._id || "").trim();
      if (!conversationId && channel !== "telegram") continue;
      const canonical = canonicalizeBulkCampaignRecipientIdentity({
        channel,
        recipient: identity.recipient,
      });
      if (canonical) uniqueIdentityKeys.add(canonical);
      dispatchItems.push({
        stableId:
          channel === "telegram" ? identity.recipientId : conversationId,
        recipientId: identity.recipientId,
        conversationId: conversationId || null,
        recipient: identity.recipient,
        sourceId: identity.recipient.sourceId || null,
        name: null,
      });
    }
  }

  assertCompleteOccurrenceCapacity({
    items: Math.max(candidateCount, dispatchItems.length),
    uniqueIdentities: uniqueIdentityKeys.size,
  });

  const routed = routeScheduleProvenance(
    scheduleCapability,
    dispatchItems.map(item => ({
      stableId: item.stableId,
      recipient: item.recipient,
    }))
  );
  const routeByStableId = new Map(
    routed.routes.map(route => [route.recipientStableId, route])
  );
  // Rows on a split path or Else left unconnected are not sent, as on the
  // bulk node; provenance already failed the run if no row was left.
  const skippedStableIds = new Set(routed.skippedStableIds ?? []);
  const routedDispatchItems =
    skippedStableIds.size > 0
      ? dispatchItems.filter(item => !skippedStableIds.has(item.stableId))
      : dispatchItems;
  if (skippedStableIds.size > 0) {
    campaignNodeRunLogger.info("campaign_node_run.unrouted_rows_skipped", {
      workspaceId: payload.workspaceId,
      scenarioId: payload.scenarioId,
      nodeId: payload.nodeId,
      columnSplitNodeId: routed.columnSplitNodeId ?? null,
      skipped: dispatchItems.length - routedDispatchItems.length,
      routed: routedDispatchItems.length,
    });
  }
  const whatsappRoutes = routed.routes.filter(
    route => route.channel === "whatsapp"
  );
  if (
    channel === "whatsapp" &&
    recipientPolicy.excludePriorFailedBulkSends &&
    whatsappRoutes.length > 0 &&
    whatsappRoutes.every(route => !route.template)
  ) {
    throw new RecurringBulkRecipientPolicyUnsupportedError();
  }

  const preflightedItems: OccurrenceDispatchItem[] = [];
  let ineligibleCount = 0;
  for (const item of routedDispatchItems) {
    const route = routeByStableId.get(item.stableId);
    if (route?.sourceId) {
      item.sourceId = route.sourceId;
      if (item.recipient && "phone" in item.recipient) {
        item.recipient = { ...item.recipient, sourceId: route.sourceId };
      } else if (item.recipient && "chatId" in item.recipient) {
        item.recipient = { ...item.recipient, sourceId: route.sourceId };
      }
    }
    if (channel === "whatsapp" && item.birthdayRecipient) {
      const routedTemplateName = route?.template?.name || templateName;
      const birthdayPayload = buildCampaignWhatsappRecipientPayload({
        workspaceId: payload.workspaceId,
        campaignId: campaignId || "pending",
        scenarioId: payload.scenarioId,
        scenarioNodeId: messageActionNodeId,
        scenarioStepTemplate: resolveBirthdayStepTemplate(
          route,
          messageActionNodeId
        ),
        recipient: item.birthdayRecipient,
        templateName: routedTemplateName,
        templateComponents:
          route?.template?.components || rawWhatsappTemplateComponents,
        requiredTemplateVariables,
        strictRequiredTemplateVariables: true,
      });
      if (
        birthdayPayload.missingRequired.length > 0 ||
        birthdayPayload.headerMediaMissing
      ) {
        ineligibleCount += 1;
        continue;
      }
    }
    preflightedItems.push(item);
  }
  const preflightUniqueKeys = new Set<string>();
  for (const item of preflightedItems) {
    const canonical = canonicalizeBulkCampaignRecipientIdentity({
      channel,
      recipient: item.recipient,
    });
    if (canonical) preflightUniqueKeys.add(canonical);
  }

  let authoritativeRecipientLimit =
    normalizeRunRecipientLimit(campaignRecipientLimit) ?? 0;
  if (channel === "whatsapp" && preflightedItems.length > 0) {
    const sourceIds = Array.from(
      new Set(
        preflightedItems.flatMap(item => {
          const sourceId = String(item.sourceId || "").trim();
          return sourceId ? [sourceId] : [];
        })
      )
    );
    if (sourceIds.length > 0) {
      const minimumPlan = await resolveMinimumBulkCampaignPlan({
        sourceIds,
        resolvePlan: async ({ sourceId }) => {
          const sendContext = await resolveWhatsAppSendContext({
            workspaceId: payload.workspaceId,
            sourceId,
          });
          if (!sendContext) {
            throw new Error("WhatsApp source plan is unavailable");
          }
          const preview = await resolvePlan({
            channel: "whatsapp",
            wabaId: sendContext.wabaId,
            phoneNumberId: sendContext.phoneNumberId,
            accessToken: sendContext.accessToken,
          });
          if (!existingCampaignId && !shadowMode) {
            assertCampaignPlanSendingReadiness(preview);
          }
          return preview;
        },
      });
      batchPlan = minimumPlan.batchPlan;
      campaignRecipientLimit = minimumPlan.recipientLimit;
      authoritativeRecipientLimit =
        normalizeRunRecipientLimit(minimumPlan.recipientLimit) ?? 0;
    }
    if (!authoritativeRecipientLimit) {
      throw new Error("WhatsApp recipient limit is unavailable");
    }
    if (bulkRecipientsRemaining !== null) {
      authoritativeRecipientLimit = Math.min(
        authoritativeRecipientLimit,
        bulkRecipientsRemaining
      );
    }
  }

  let acceptedItems = preflightedItems;
  let skippedByReason: Partial<
    Record<
      | "ineligible"
      | "marketing_opt_out"
      | "recent_contact"
      | "recipient_limit"
      | "prior_failure",
      number
    >
  > = {};
  let missingMarketingConsent = 0;
  let uniqueRequested = preflightUniqueKeys.size;
  let uniqueAccepted = preflightUniqueKeys.size;

  if (channel === "whatsapp" && preflightedItems.length > 0) {
    const hmacSecret = process.env.ENCRYPTION_SECRET?.trim() || "";
    const templateCategory =
      (whatsappRoutes.find(route => route.template?.category)?.template
        ?.category as "MARKETING" | "UTILITY" | "AUTHENTICATION" | undefined) ||
      whatsappTemplateCategory ||
      "MARKETING";
    const evaluation = await evaluateRecipientPolicy({
      workspaceId: payload.workspaceId,
      channel: "whatsapp",
      candidates: preflightedItems.map(item => ({
        value: item,
        stableId: item.stableId,
        recipient: item.recipient,
        templateCategory,
      })),
      recipientLimit: authoritativeRecipientLimit,
      completeness: {
        complete: true,
        uniqueRecipients: preflightUniqueKeys.size,
        dispatchItems: preflightedItems.length,
        uniqueRecipientHardCap: MAX_BULK_CAMPAIGN_RECIPIENTS,
        dispatchItemHardCap: MAX_BULK_CAMPAIGN_RECIPIENTS,
      },
      policy: recipientPolicy,
      ...(recipientPolicy.excludePriorFailedBulkSends
        ? {
            priorFailure: {
              client: supabaseAdmin,
              secret: hmacSecret,
            },
          }
        : {}),
    });
    acceptedItems = evaluation.retained.map(candidate => candidate.value);
    skippedByReason = evaluation.skippedByReason;
    missingMarketingConsent = evaluation.warnings.missingMarketingConsent;
    uniqueRequested = evaluation.uniqueRecipients.requested;
    uniqueAccepted = evaluation.uniqueRecipients.accepted;
  } else if (channel === "whatsapp") {
    uniqueRequested = 0;
    uniqueAccepted = 0;
  }
  const allowance = bulkRecipientsRemaining;
  if (channel !== "whatsapp" && allowance !== null) {
    // Free plans keep the first recipients that fit the bulk allowance, as
    // WhatsApp runs do through the recipient policy above.
    const keptIdentities = new Set<string>();
    const kept = acceptedItems.filter(item => {
      const identity =
        canonicalizeBulkCampaignRecipientIdentity({
          channel,
          recipient: item.recipient,
        }) ?? item.stableId;
      if (keptIdentities.has(identity)) return true;
      if (keptIdentities.size >= allowance) return false;
      keptIdentities.add(identity);
      return true;
    });
    if (kept.length < acceptedItems.length) {
      skippedByReason = {
        ...skippedByReason,
        recipient_limit:
          (skippedByReason.recipient_limit || 0) +
          acceptedItems.length -
          kept.length,
      };
      acceptedItems = kept;
      uniqueAccepted = keptIdentities.size;
    }
  }

  const eligibilityOutcome = accumulateBulkCampaignEligibilityOutcome({
    requestedTotal: routedDispatchItems.length,
    acceptedTotal: acceptedItems.length,
    uniqueRecipients: {
      requested: uniqueRequested,
      accepted: uniqueAccepted,
    },
    stages: [
      ...(ineligibleCount > 0
        ? [
            {
              skippedByReason: { ineligible: ineligibleCount },
              warnings: { missingMarketingConsent: 0 },
            },
          ]
        : []),
      {
        skippedByReason,
        warnings: { missingMarketingConsent },
      },
    ],
  });
  emitBulkCampaignPolicyEvent(campaignNodeRunLogger, {
    workspaceId: payload.workspaceId,
    channel,
    messageKind:
      channel === "whatsapp"
        ? "template"
        : channel === "telegram"
          ? "telegram"
          : "email",
    executionSource: payload.executionSource,
    scenarioId: payload.scenarioId,
    rootNodeId: scheduleContext.rootNodeId,
    itemCounts: {
      requested: eligibilityOutcome.requestedTotal,
      accepted: eligibilityOutcome.acceptedTotal,
      queued: acceptedItems.length,
    },
    uniqueRecipientCounts: {
      requested: eligibilityOutcome.uniqueRecipients.requested,
      accepted: eligibilityOutcome.uniqueRecipients.accepted,
      queued: eligibilityOutcome.uniqueRecipients.accepted,
    },
    skippedByReason: eligibilityOutcome.skippedByReason,
    warnings: eligibilityOutcome.warnings,
    disposition: acceptedItems.length > 0 ? "queued" : "no_op",
    planLimit: {
      source: campaignRecipientLimit?.source || "unavailable",
      value: authoritativeRecipientLimit || null,
    },
    policy: recipientPolicy,
    idempotentReplay: Boolean(existingCampaignId),
  });

  const historyScenario = scenario;
  const historyNode = node;
  async function reserveHistoryIfNeeded(): Promise<
    | { status: "ready"; campaignId: string | null }
    | { status: "skipped"; reason: string }
  > {
    if (shadowMode) return { status: "ready", campaignId };
    if (campaignId) return { status: "ready", campaignId };
    if (
      companyBulkCampaignLimit === undefined ||
      companySubscriptionType === undefined
    ) {
      throw new Error(
        "Campaign history reservation is missing the company plan snapshot"
      );
    }
    const sentBy =
      typeof historyScenario.updatedBy === "string" &&
      historyScenario.updatedBy.trim()
        ? historyScenario.updatedBy.trim()
        : typeof historyScenario.createdBy === "string" &&
            historyScenario.createdBy.trim()
          ? historyScenario.createdBy.trim()
          : null;
    const createdCampaign = await createCampaignHistoryRecord({
      supabase: supabaseAdmin,
      workspaceId: payload.workspaceId,
      name: `${historyScenario.name || "Bulk scenario"} - ${String(historyNode.data?.label || historyNode.id)}`,
      channel,
      templateName:
        channel === "whatsapp"
          ? templateName
          : channel === "email"
            ? emailTemplateKey
            : null,
      templateLanguage: channel === "whatsapp" ? templateLanguage : null,
      messageText:
        channel === "telegram"
          ? telegramMessageText
          : channel === "email"
            ? emailSubjectOverride || null
            : null,
      totalRecipients: 0,
      companyBulkCampaignLimit,
      companySubscriptionType,
      sentBy,
      scenarioId: String(historyScenario._id),
      scenarioNodeId: String(historyNode.id || ""),
      executionSource: payload.executionSource,
      executionRunKey: runKey,
    });

    if (createdCampaign.status === "skipped") {
      return { status: "skipped", reason: createdCampaign.code };
    }
    if (createdCampaign.status === "blocked") {
      return {
        status: "skipped",
        reason: COMPANY_BULK_CAMPAIGN_LIMIT_EXCEEDED_CODE,
      };
    }
    if (createdCampaign.status === "conflict") {
      throw new Error(
        "Company plan changed while reserving the campaign; retry the run"
      );
    }
    if (createdCampaign.status === "failed") {
      throw new Error(
        `Failed to reserve campaign history: ${createdCampaign.errorMessage}`
      );
    }
    return { status: "ready", campaignId: createdCampaign.campaignId };
  }

  if (!shadowMode) {
    const reservation = await reserveHistoryIfNeeded();
    if (reservation.status === "skipped") {
      return buildSkippedResult(payload, reservation.reason);
    }
    campaignId = reservation.campaignId;
  }

  const reconcileDurableTaskCounts = async () => {
    if (!campaignId || shadowMode) return null;
    const counts = await getCampaignNodeRunTaskCounts({
      workspaceId: payload.workspaceId,
      scenarioId: payload.scenarioId,
      nodeId: payload.nodeId,
      runKey,
      campaignId,
      executionSource: payload.executionSource,
    });
    await updateCampaignHistoryRecipientCount({
      supabase: supabaseAdmin,
      workspaceId: payload.workspaceId,
      campaignId,
      channel,
      totalRecipients: counts.total,
      scenarioId: payload.scenarioId,
      scenarioNodeId: payload.nodeId,
      executionSource: payload.executionSource,
      executionRunKey: runKey,
    });
    return counts;
  };

  if (acceptedItems.length === 0) {
    const durableTaskCounts = await reconcileDurableTaskCounts();
    return Object.assign(
      {
        status: shadowMode ? ("shadow" as const) : ("materialized" as const),
        shadowMode,
        scenarioId: payload.scenarioId,
        nodeId: payload.nodeId,
        campaignId,
        audienceSource,
        runKey,
        deliveryRuntime: "campaign_delivery" as const,
        candidates: candidateCount,
        created: 0,
        wouldCreate: 0,
        pendingCount: durableTaskCounts?.pending ?? 0,
        batchPlan,
      },
      { queued: 0 }
    );
  }

  const hmacSecret = process.env.ENCRYPTION_SECRET?.trim();
  if (!hmacSecret && !shadowMode) {
    throw new Error(
      "ENCRYPTION_SECRET is required to hash campaign recipient identities"
    );
  }

  const operations = acceptedItems.flatMap(item => {
    let birthdayTemplateComponents: CampaignSendTemplateComponent[] | null =
      null;
    if (channel === "whatsapp" && item.birthdayRecipient) {
      const route = routeByStableId.get(item.stableId);
      const birthdayPayload = buildCampaignWhatsappRecipientPayload({
        workspaceId: payload.workspaceId,
        campaignId,
        scenarioId: payload.scenarioId,
        scenarioNodeId: messageActionNodeId,
        scenarioStepTemplate: resolveBirthdayStepTemplate(
          route,
          messageActionNodeId
        ),
        recipient: item.birthdayRecipient,
        templateName: route?.template?.name || templateName,
        templateComponents:
          route?.template?.components || rawWhatsappTemplateComponents,
        requiredTemplateVariables,
      });
      birthdayTemplateComponents = birthdayPayload.components || null;
    }
    const recipientHash = hmacSecret
      ? hashOccurrenceRecipient({
          secret: hmacSecret,
          workspaceId: payload.workspaceId,
          channel,
          recipient: item.recipient,
        })
      : null;
    const deliveryIdentity = buildCampaignNodeRunDeliveryIdentity({
      scenarioId: payload.scenarioId,
      nodeId: payload.nodeId,
      executionSource: payload.executionSource,
      recipientId: item.recipientId,
      runKey,
    });
    return [
      {
        updateOne: {
          filter: buildCampaignNodeRunDeliveryFilter(
            deliveryIdentity,
            payload.executionSource
          ),
          update: {
            $setOnInsert: {
              workspaceId: payload.workspaceId,
              scenarioId: payload.scenarioId,
              nodeId: payload.nodeId,
              conversationId: item.conversationId,
              campaignId,
              executionSource: payload.executionSource,
              channel,
              provider,
              deliveryMode: useEmailBatchDelivery ? "batch" : "single",
              audienceSource,
              requiresRevalidation:
                audienceSource === "dynamic" && !item.birthdayRecipient,
              sourceId:
                channel === "telegram"
                  ? telegramSourceId || item.sourceId
                  : item.sourceId,
              recipientPhone:
                channel === "whatsapp"
                  ? item.birthdayRecipient?.phone ||
                    item.recipient.phone ||
                    null
                  : null,
              recipientChatId:
                channel === "telegram"
                  ? item.birthdayRecipient?.chatId ||
                    item.recipient.chatId ||
                    null
                  : null,
              recipientEmail:
                channel === "email" ? item.recipient.email || null : null,
              recipientName: item.name || item.birthdayRecipient?.name || null,
              recipientHash,
              scheduleId: payload.scheduleId || null,
              scheduledFor: scheduledForDate,
              runKey,
              templateName: channel === "whatsapp" ? templateName : null,
              templateLanguage:
                channel === "whatsapp" ? templateLanguage : null,
              templateCategory:
                channel === "whatsapp" ? whatsappTemplateCategory : null,
              templateComponents:
                channel === "whatsapp"
                  ? item.birthdayRecipient
                    ? birthdayTemplateComponents
                    : templateComponents
                  : null,
              messageText:
                channel === "telegram"
                  ? item.birthdayRecipient
                    ? personalizeCampaignTelegramMessage(
                        telegramMessageText,
                        item.birthdayRecipient.variables
                      )
                    : null
                  : null,
              emailTemplateKey: channel === "email" ? emailTemplateKey : null,
              emailTemplateModel:
                channel === "email" ? emailTemplateModel : null,
              emailSubjectOverride:
                channel === "email" ? emailSubjectOverride || null : null,
              emailMessageStream:
                channel === "email" ? emailMessageStream || null : null,
              nextInternalLabel: nextInternalLabel || null,
              dispatchAt: effectiveNow,
              dispatchExpiresAt,
              status: "pending",
              attempts: 0,
              processingStartedAt: null,
              processingLeaseId: null,
              processingLeaseHeartbeatAt: null,
              completedAt: null,
              skipReason: null,
              lastError: null,
              idempotencyKey: deliveryIdentity.idempotencyKey,
              wakeMethod: null,
              wakeMessageId: null,
              wakeScheduledFor: null,
              wakePublishedAt: null,
              wakeCancelledAt: null,
            },
          },
          upsert: true,
        },
      },
    ];
  });

  if (!shadowMode) {
    for (const chunk of chunkOperations(
      operations,
      DELIVERY_TASK_BULK_WRITE_CHUNK_SIZE
    )) {
      if (chunk.length === 0) continue;
      const writeResult = await bulkWriteTasks(chunk, { ordered: false });
      createdCount += writeResult.upsertedCount || 0;
    }
  } else if (ignoreExistingDeliveryTasks) {
    wouldCreateCount += acceptedItems.length;
  } else {
    const identities = acceptedItems.map(item =>
      buildCampaignNodeRunDeliveryIdentity({
        scenarioId: payload.scenarioId,
        nodeId: payload.nodeId,
        executionSource: payload.executionSource,
        recipientId: item.recipientId,
        runKey,
      })
    );
    const existingMatches = await countExistingDeliveryIdentities({
      identities,
      executionSource: payload.executionSource,
    });
    wouldCreateCount += Math.max(0, identities.length - existingMatches);
  }

  const durableTaskCounts = await reconcileDurableTaskCounts();

  return Object.assign(
    {
      status: shadowMode ? ("shadow" as const) : ("materialized" as const),
      shadowMode,
      scenarioId: payload.scenarioId,
      nodeId: payload.nodeId,
      campaignId,
      audienceSource,
      runKey,
      deliveryRuntime: "campaign_delivery" as const,
      candidates: candidateCount,
      created: createdCount,
      wouldCreate: shadowMode ? wouldCreateCount : createdCount,
      pendingCount: shadowMode ? 0 : (durableTaskCounts?.pending ?? 0),
      batchPlan,
    },
    { queued: acceptedItems.length }
  );
}
