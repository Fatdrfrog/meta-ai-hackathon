import "server-only";

import {
  normalizeBulkCampaignRecipientPolicy,
  type BulkCampaignRecipientPolicy,
  type BulkCampaignSkipReason,
  type ScenarioGeneratorChannel,
} from "@icecore/scenario-contracts";
import type {
  WhatsAppComponent,
  WhatsAppTemplate,
} from "@icecore/shared/types/whatsapp";
import type {
  BulkCampaignDispatchBatchPlan,
  BulkCampaignDispatchItem,
} from "@icecore/temporal";

import { supabaseAdmin } from "@/lib/supabase/admin";
import { normalizeWhatsAppTemplateComponents } from "@/lib/scenarios/normalization";
import { resolveTelegramSendContextResult } from "@/lib/telegram/source-context";
import { normalizeTelegramChatId } from "@/lib/telegram/chat-id";
import { buildEmailUnsubscribeUrl } from "@/lib/email/email-unsubscribes";
import {
  resolveWhatsAppSendContextResult,
  type WhatsAppSendContext,
} from "@/lib/whatsapp/send-context";
import {
  getTemplateHeaderMedia,
  mergeComponentsWithUnifiedHeaderMediaUrl,
} from "@/lib/whatsapp/templates/header-media-utils";
import { listApprovedWhatsAppTemplatesForSend } from "@/lib/whatsapp/templates/send-lookup";
import { normalizeWhatsAppTemplateLanguageForSend } from "@icecore/shared/constants/whatsapp-templates";
import { buildWhatsAppTemplateSendComponentsFromTemplate } from "@/lib/whatsapp/templates/message-types";
import { readTrimmedString as asString } from "@icecore/shared/lib/value-utils";

import {
  isValidCampaignEmailAddress,
  normalizeCampaignEmail,
  normalizeCampaignPhone,
} from "./campaign-recipient-utils";
import { createStableJsonSha256 } from "./bulk-campaign-content-hash";
import { deriveBulkSendChildCampaignId } from "./bulk-send-api-idempotency";
import {
  assertCampaignPlanSendingReadiness,
  resolveCampaignBatchPlanPreview,
  type CampaignBatchPlanPreview,
} from "./campaign-batch-plan";
import {
  bulkCampaignTemplateLookupError,
  resolveMinimumBulkCampaignPlan,
} from "./bulk-campaign-recipient-eligibility";
import {
  BulkRecipientPolicyError,
  evaluateBulkRecipientPolicy,
  type BulkRecipientPolicyInput,
  type BulkRecipientPolicyEvaluation,
} from "./bulk-recipient-policy";
import {
  accumulateBulkCampaignEligibilityOutcome,
  type BulkCampaignAccumulatedEligibilityOutcome,
} from "./bulk-campaign-outcome";
import type { BulkCampaignAuthoritativeRecipientLimit } from "./bulk-campaign-admission";
import {
  filterEmailUnsubscribedRecipients,
  resolveBulkCampaignAppBaseUrl,
  resolveEmailBulkSendContextStrict,
} from "./email-bulk-preflight";
import { filterKnownMarketingOptOutRecipients } from "./marketing-opt-in";
import { resolveEligibleTelegramBulkRecipients } from "./telegram-bulk-preflight";
import { resolveWhatsAppConversationHistoryEligibility } from "./whatsapp-bulk-preflight";
import {
  assertBulkPrimaryWhatsAppTemplateHasNoConversationBindings,
  type VerifiedGeneratedBulkCampaignRoute,
} from "./bulk-campaign-provenance";

const SOURCE_LOOKUP_CONCURRENCY = 25;
const GENERATED_BULK_PREPARATION_DIGEST_VERSION = 3;
const GENERATED_BULK_LEGACY_PREPARATION_DIGEST_VERSION = 2;
const GENERATED_BULK_MAX_ITEMS = 3_000;
const GENERATED_BULK_MAX_WHATSAPP_IDENTITIES = 1_000;

type ApprovedWhatsAppCategory = "MARKETING" | "UTILITY" | "AUTHENTICATION";

export type GeneratedBulkCampaignMessageInput = {
  _id: unknown;
  nodeId: string;
  branchId?: string | null;
  channel: ScenarioGeneratorChannel;
  recipient: string;
  recipientEmail?: string | null;
  recipientName?: string | null;
  sourceId?: string | null;
  text: string;
  mediaAssetIds?: string[];
};

export type GeneratedBulkCampaignNodeInput = {
  id: string;
  data?: {
    kind?: string;
    actionType?: string;
    actionWhatsAppTemplateName?: unknown;
    actionWhatsAppTemplateLanguage?: unknown;
    actionWhatsAppTemplateComponents?: unknown;
    actionMediaAssets?: unknown;
    generatedTemplateDraft?: {
      id?: unknown;
      status?: unknown;
      category?: unknown;
    } | null;
    [key: string]: unknown;
  };
};

type GeneratedBulkCampaignSkippedOutcome = {
  reason: string;
  detail?: string | null;
};

export type PreparedGeneratedBulkPartition = {
  partitionKey: string;
  channel: ScenarioGeneratorChannel;
  sourceId: string | null;
  campaignId: string;
  items: BulkCampaignDispatchItem[];
  candidateMessageIds: string[];
  templateName: string | null;
  templateLanguage: string | null;
  messageText: string | null;
  batchPlan: BulkCampaignDispatchBatchPlan;
  requestedTotal: number;
  skippedOptIn: number;
  authoritativeRecipientLimit?: BulkCampaignAuthoritativeRecipientLimit;
  policyOutcome?: BulkCampaignAccumulatedEligibilityOutcome;
};

export type PreparedGeneratedWhatsAppPolicyFacts = {
  policy: BulkCampaignRecipientPolicy;
  authoritativeRecipientLimit?: BulkCampaignAuthoritativeRecipientLimit;
  outcome: BulkCampaignAccumulatedEligibilityOutcome;
};

export type PreparedGeneratedBulkCampaignResult = {
  requestedMessageIds: string[];
  partitions: PreparedGeneratedBulkPartition[];
  skippedByMessageId: Record<string, GeneratedBulkCampaignSkippedOutcome>;
  whatsappPolicyFacts?: PreparedGeneratedWhatsAppPolicyFacts;
  preparationDigestVersion:
    | typeof GENERATED_BULK_PREPARATION_DIGEST_VERSION
    | typeof GENERATED_BULK_LEGACY_PREPARATION_DIGEST_VERSION;
  preparationDigest: string;
};

type PrepareGeneratedBulkCampaignPartitionsInput = {
  workspaceId: string;
  scenarioId: string;
  sentByUserId: string;
  operationId: string;
  campaignName: string;
  requestUrl: string;
  messages: GeneratedBulkCampaignMessageInput[];
  nodes: GeneratedBulkCampaignNodeInput[];
  fallbackSourceIds: string[];
  recipientPolicy: BulkCampaignRecipientPolicy;
  verifiedRoutes?: readonly VerifiedGeneratedBulkCampaignRoute[];
  verifiedWhatsAppTemplateCapability?: boolean;
  digestMode?: "current_v3" | "legacy_v2_disabled";
  dependencies?: {
    evaluateRecipientPolicy?: <T>(
      input: BulkRecipientPolicyInput<T>
    ) => Promise<BulkRecipientPolicyEvaluation<T>>;
    resolvePlan?: typeof resolveCampaignBatchPlanPreview;
  };
};

export class GeneratedBulkRecipientPolicyUnsupportedError extends Error {
  readonly code = "bulk_recipient_policy_unsupported" as const;

  constructor() {
    super(
      "The persisted generated recipient policy requires a verified WhatsApp template capability"
    );
    this.name = "GeneratedBulkRecipientPolicyUnsupportedError";
  }
}

type PreparedWork = {
  ordinal: number;
  messageId: string;
  message: GeneratedBulkCampaignMessageInput;
  verifiedRoute?: VerifiedGeneratedBulkCampaignRoute;
  node?: GeneratedBulkCampaignNodeInput;
  sourceId?: string | null;
  partitionKey?: string;
  whatsappContext?: WhatsAppSendContext;
  whatsappTemplate?: WhatsAppTemplate;
  whatsappResolvedTemplateComponents?: WhatsAppComponent[];
  whatsappCategory?: ApprovedWhatsAppCategory;
  whatsappLanguage?: string;
  whatsappPhone?: string;
  whatsappComponents?: unknown[];
  telegramChatId?: string;
  telegramBusinessConnectionId?: string;
  email?: string;
};

function normalizeMessageId(value: unknown): string {
  const messageId = String(value ?? "").trim();
  if (!messageId) {
    throw new Error("Generated bulk preparation requires every message ID");
  }
  return messageId;
}

function normalizeRequiredInput(value: unknown, label: string): string {
  const normalized = asString(value);
  if (!normalized) {
    throw new Error(`Generated bulk preparation requires ${label}`);
  }
  return normalized;
}

function approvedTemplateKey(name: string, language: string): string {
  return `${name.trim().toLowerCase()}:${normalizeWhatsAppTemplateLanguageForSend(
    language
  )}`;
}

function isApprovedWhatsAppCategory(
  value: unknown
): value is ApprovedWhatsAppCategory {
  return (
    value === "MARKETING" || value === "UTILITY" || value === "AUTHENTICATION"
  );
}

function normalizeRecipientName(
  message: GeneratedBulkCampaignMessageInput
): string {
  return asString(message.recipientName) || "Customer";
}

function buildGeneratedTemplateValues(
  message: GeneratedBulkCampaignMessageInput
): Record<string, string> {
  const name = normalizeRecipientName(message);
  const text = asString(message.text);
  return {
    "1": name,
    "2": text,
    name,
    full_name: name,
    customer_name: name,
    first_name: name.split(/\s+/).filter(Boolean)[0] || name,
    generated_message: text,
    campaign_text: text,
    message: text,
    phone: message.channel === "whatsapp" ? message.recipient : "",
    wa_id: message.channel === "whatsapp" ? message.recipient : "",
    chat_id: message.channel === "telegram" ? message.recipient : "",
    email: message.channel === "email" ? message.recipient : "",
  };
}

function buildGeneratedEmailTemplateModel(params: {
  campaignName: string;
  message: GeneratedBulkCampaignMessageInput;
  unsubscribeUrl: string;
}): Record<string, string> {
  const name = normalizeRecipientName(params.message);
  const text = asString(params.message.text);
  return {
    title: params.campaignName || "Generated campaign",
    headline: params.campaignName || "Generated campaign",
    body: text,
    message: text,
    ctaText: "Reply",
    recipientName: name,
    name,
    unsubscribeUrl: params.unsubscribeUrl,
  };
}

async function mapInBoundedBatches<T, TResult>(
  values: T[],
  mapValue: (value: T) => Promise<TResult>
): Promise<TResult[]> {
  const results: TResult[] = [];
  for (
    let offset = 0;
    offset < values.length;
    offset += SOURCE_LOOKUP_CONCURRENCY
  ) {
    results.push(
      ...(await Promise.all(
        values.slice(offset, offset + SOURCE_LOOKUP_CONCURRENCY).map(mapValue)
      ))
    );
  }
  return results;
}

function distinctNonEmpty(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map(asString).filter(Boolean)));
}

function commonValue(values: Array<string | null | undefined>): string | null {
  if (values.length === 0) return null;
  const normalized = values.map(value => asString(value));
  const first = normalized[0] || "";
  return first && normalized.every(value => value === first) ? first : null;
}

function assertTotalPreparationResult(
  requestedMessageIds: string[],
  partitions: PreparedGeneratedBulkPartition[],
  skippedByMessageId: Record<string, GeneratedBulkCampaignSkippedOutcome>
) {
  const classified = [
    ...partitions.flatMap(partition => partition.candidateMessageIds),
    ...Object.keys(skippedByMessageId),
  ];
  const classifiedSet = new Set(classified);
  if (
    classified.length !== requestedMessageIds.length ||
    classifiedSet.size !== requestedMessageIds.length ||
    requestedMessageIds.some(messageId => !classifiedSet.has(messageId))
  ) {
    throw new Error(
      "Generated bulk preparation must classify every requested message exactly once"
    );
  }
  for (const partition of partitions) {
    if (
      partition.items.length !== partition.candidateMessageIds.length ||
      partition.items.some(
        (item, index) =>
          item.generatedRecipientMessageId !==
          partition.candidateMessageIds[index]
      )
    ) {
      throw new Error(
        "Generated bulk preparation item and message ID indexes must align"
      );
    }
  }
}

function omitEmailUnsubscribeValue(
  values: Record<string, string> | undefined
): Record<string, string> | null {
  if (!values) return null;
  return Object.fromEntries(
    Object.entries(values).filter(([key]) => key !== "unsubscribeUrl")
  );
}

function stableWhatsAppTemplateComponents(
  components: WhatsAppComponent[] | undefined
): unknown[] | null {
  if (!components) return null;
  return components.map(component => {
    if (
      component.type !== "HEADER" ||
      !["IMAGE", "VIDEO", "DOCUMENT"].includes(component.format || "")
    ) {
      return component;
    }
    const headerHandles = component.example?.header_handle;
    return {
      ...component,
      ...(component.example
        ? {
            example: {
              ...component.example,
              ...(headerHandles
                ? {
                    header_handle: headerHandles.map(() => "<media>"),
                  }
                : {}),
            },
          }
        : {}),
    };
  });
}

function stableWhatsAppSendComponents(
  components: unknown[] | undefined
): unknown[] | null {
  if (!components) return null;
  return components.map(component => {
    if (!component || typeof component !== "object") return component;
    const componentRecord = component as Record<string, unknown>;
    if (asString(componentRecord.type).toLowerCase() !== "header") {
      return component;
    }
    const parameters = Array.isArray(componentRecord.parameters)
      ? componentRecord.parameters
      : [];
    return {
      ...componentRecord,
      parameters: parameters.map(parameter => {
        if (!parameter || typeof parameter !== "object") return parameter;
        const parameterRecord = parameter as Record<string, unknown>;
        const parameterType = asString(parameterRecord.type).toLowerCase();
        if (!["image", "video", "document"].includes(parameterType)) {
          return parameter;
        }
        const mediaValue = parameterRecord[parameterType];
        if (!mediaValue || typeof mediaValue !== "object") {
          return parameter;
        }
        const mediaRecord = mediaValue as Record<string, unknown>;
        return {
          ...parameterRecord,
          [parameterType]: {
            ...mediaRecord,
            ...("link" in mediaRecord ? { link: "<media>" } : {}),
            ...("id" in mediaRecord ? { id: "<media>" } : {}),
          },
        };
      }),
    };
  });
}

function stableNodeMediaAssetIds(work: PreparedWork): string[] {
  const assets = work.node?.data?.actionMediaAssets;
  if (!Array.isArray(assets)) return [];
  return distinctNonEmpty(
    assets.map(asset =>
      asset && typeof asset === "object"
        ? asString((asset as Record<string, unknown>).id)
        : ""
    )
  ).sort((left, right) => left.localeCompare(right));
}

function normalizeExactMediaLocator(value: unknown): string {
  const locator = asString(value);
  if (!locator) return "";
  try {
    const parsed = new URL(locator);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch {
    // Opaque Meta handles are compared as exact trimmed values.
  }
  return locator;
}

function readPersistedHeaderMediaLocator(work: PreparedWork): string {
  const components = normalizeWhatsAppTemplateComponents(
    work.node?.data?.actionWhatsAppTemplateComponents
  );
  const templateMedia = getTemplateHeaderMedia(components);
  if (templateMedia?.value) {
    return normalizeExactMediaLocator(templateMedia.value);
  }

  const header = components?.find(
    component =>
      component &&
      typeof component === "object" &&
      asString(
        (component as unknown as Record<string, unknown>).type
      ).toLowerCase() === "header"
  ) as unknown as Record<string, unknown> | undefined;
  const parameters = Array.isArray(header?.parameters) ? header.parameters : [];
  for (const parameter of parameters) {
    if (!parameter || typeof parameter !== "object") continue;
    const parameterRecord = parameter as Record<string, unknown>;
    const type = asString(parameterRecord.type).toLowerCase();
    if (!["image", "video", "document"].includes(type)) continue;
    const media = parameterRecord[type];
    if (!media || typeof media !== "object") continue;
    const mediaRecord = media as Record<string, unknown>;
    const locator = normalizeExactMediaLocator(
      mediaRecord.link || mediaRecord.id
    );
    if (locator) return locator;
  }
  return "";
}

function resolveSelectedHeaderMediaAssetId(work: PreparedWork): string | null {
  const selectedLocator = readPersistedHeaderMediaLocator(work);
  if (!selectedLocator) return null;

  const assets = work.node?.data?.actionMediaAssets;
  const matchingIds = distinctNonEmpty(
    Array.isArray(assets)
      ? assets.flatMap(asset => {
          if (!asset || typeof asset !== "object") return [];
          const record = asset as Record<string, unknown>;
          return normalizeExactMediaLocator(record.url) === selectedLocator
            ? [asString(record.id)]
            : [];
        })
      : []
  );
  if (matchingIds.length === 1) return matchingIds[0];

  throw new Error(
    `Cannot derive stable selected header media identity for ${work.message.nodeId}`
  );
}

function stableItemSemantics(
  item: BulkCampaignDispatchItem,
  workByMessageId: Map<string, PreparedWork>
) {
  const common = {
    generatedRecipientMessageId: item.generatedRecipientMessageId || null,
    scenarioNodeId: item.scenarioNodeId || null,
  };
  if (item.channel === "whatsapp") {
    if (item.whatsappMessageType === "service_text") {
      return {
        ...common,
        channel: item.channel,
        whatsappMessageType: item.whatsappMessageType,
        sourceId: item.sourceId,
        recipient: item.recipient,
        phoneNumberId: item.phoneNumberId,
        messageText: item.messageText,
        serviceWindowExpiresAt: item.serviceWindowExpiresAt,
      };
    }
    const work = workByMessageId.get(item.generatedRecipientMessageId || "");
    return {
      ...common,
      channel: item.channel,
      sourceId: item.sourceId || null,
      recipient: item.recipient,
      phoneNumberId: item.phoneNumberId,
      templateName: item.templateName,
      languageCode: item.languageCode || null,
      templateCategory: item.templateCategory || null,
      messageMediaAssetIds: distinctNonEmpty(
        work?.message.mediaAssetIds || []
      ).sort((left, right) => left.localeCompare(right)),
      nodeMediaAssetIds: work ? stableNodeMediaAssetIds(work) : [],
      selectedHeaderMediaAssetId: work
        ? resolveSelectedHeaderMediaAssetId(work)
        : null,
      generatedTemplateDraftId:
        asString(work?.node?.data?.generatedTemplateDraft?.id) || null,
      templateComponents: stableWhatsAppTemplateComponents(
        work?.whatsappResolvedTemplateComponents
      ),
      components: stableWhatsAppSendComponents(item.components),
    };
  }
  if (item.channel === "telegram") {
    return {
      ...common,
      channel: item.channel,
      sourceId: item.sourceId || null,
      businessConnectionId: item.businessConnectionId || null,
      recipient: item.recipient,
      messageText: item.messageText,
    };
  }
  return {
    ...common,
    channel: item.channel,
    recipient: {
      email: item.recipient.email,
      variables: omitEmailUnsubscribeValue(item.recipient.variables),
    },
    fromAddress: item.fromAddress || null,
    templateKey: item.templateKey || null,
    templateModel: omitEmailUnsubscribeValue(item.templateModel),
    subjectOverride: item.subjectOverride || null,
    emailContent: item.emailContent || null,
    messageStream: item.messageStream || null,
  };
}

function createPreparationDigest(params: {
  version: 2 | 3;
  requestedMessageIds: string[];
  partitions: PreparedGeneratedBulkPartition[];
  skippedByMessageId: Record<string, GeneratedBulkCampaignSkippedOutcome>;
  works: PreparedWork[];
  whatsappPolicyFacts?: PreparedGeneratedWhatsAppPolicyFacts;
}): string {
  const workByMessageId = new Map(
    params.works.map(work => [work.messageId, work])
  );
  const semanticInput = {
    version: params.version,
    requestedMessageIds: params.requestedMessageIds,
    partitions: params.partitions.map(partition => ({
      partitionKey: partition.partitionKey,
      channel: partition.channel,
      sourceId: partition.sourceId,
      campaignId: partition.campaignId,
      candidateMessageIds: partition.candidateMessageIds,
      templateName: partition.templateName,
      templateLanguage: partition.templateLanguage,
      messageText: partition.messageText,
      batchPlan: {
        batchSize: partition.batchPlan.batchSize,
        delayMs: partition.batchPlan.delayMs,
        ratePerSecond: partition.batchPlan.ratePerSecond,
        rateSource: partition.batchPlan.rateSource,
        throughputLevel: partition.batchPlan.throughputLevel ?? null,
      },
      requestedTotal: partition.requestedTotal,
      skippedOptIn: partition.skippedOptIn,
      ...(params.version === 3 && partition.policyOutcome
        ? {
            authoritativeRecipientLimit:
              partition.authoritativeRecipientLimit ?? null,
            policyOutcome: partition.policyOutcome,
          }
        : {}),
      items: partition.items.map(item =>
        stableItemSemantics(item, workByMessageId)
      ),
    })),
    skipped: params.requestedMessageIds.flatMap(messageId => {
      const outcome = params.skippedByMessageId[messageId];
      return outcome
        ? [
            {
              messageId,
              reason: outcome.reason,
              detail: outcome.detail || null,
            },
          ]
        : [];
    }),
    ...(params.version === 3
      ? { whatsappPolicyFacts: params.whatsappPolicyFacts ?? null }
      : {}),
  };
  return createStableJsonSha256(semanticInput);
}

export async function prepareGeneratedBulkCampaignPartitions(
  input: PrepareGeneratedBulkCampaignPartitionsInput
): Promise<PreparedGeneratedBulkCampaignResult> {
  const workspaceId = normalizeRequiredInput(input.workspaceId, "workspaceId");
  const scenarioId = normalizeRequiredInput(input.scenarioId, "scenarioId");
  const sentByUserId = normalizeRequiredInput(
    input.sentByUserId,
    "sentByUserId"
  );
  const operationId = normalizeRequiredInput(input.operationId, "operationId");
  const campaignName = asString(input.campaignName) || "Generated campaign";
  const digestMode = input.digestMode ?? "current_v3";
  const recipientPolicy = normalizeBulkCampaignRecipientPolicy(
    input.recipientPolicy
  );
  if (
    digestMode === "legacy_v2_disabled" &&
    recipientPolicy.excludePriorFailedBulkSends
  ) {
    throw new Error("Legacy generated preparation requires disabled policy");
  }
  if (input.messages.length > GENERATED_BULK_MAX_ITEMS) {
    throw new Error(
      "Generated bulk preparation accepts at most 3,000 generated messages"
    );
  }
  const canonicalWhatsAppIdentities = new Set(
    input.messages.flatMap(message => {
      if (message.channel !== "whatsapp") return [];
      const phone = normalizeCampaignPhone(message.recipient);
      if (!phone) {
        throw new BulkRecipientPolicyError("invalid_recipient_identity");
      }
      return [phone];
    })
  );
  if (
    canonicalWhatsAppIdentities.size > GENERATED_BULK_MAX_WHATSAPP_IDENTITIES
  ) {
    throw new Error(
      "Generated bulk preparation accepts at most 1,000 canonical WhatsApp identities"
    );
  }
  const requestedMessageIds = input.messages.map(message =>
    normalizeMessageId(message._id)
  );
  if (new Set(requestedMessageIds).size !== requestedMessageIds.length) {
    throw new Error("Generated bulk preparation message IDs must be unique");
  }

  const verifiedRouteByMessageId = input.verifiedRoutes
    ? new Map(
        input.verifiedRoutes.map(route => [route.recipientStableId, route])
      )
    : null;
  if (
    verifiedRouteByMessageId &&
    (verifiedRouteByMessageId.size !== input.verifiedRoutes!.length ||
      verifiedRouteByMessageId.size !== requestedMessageIds.length)
  ) {
    throw new Error(
      "Verified generated provenance must cover every message exactly once"
    );
  }
  const works: PreparedWork[] = input.messages.map((message, ordinal) => {
    const messageId = requestedMessageIds[ordinal];
    const verifiedRoute = verifiedRouteByMessageId?.get(messageId);
    if (
      verifiedRouteByMessageId &&
      (!verifiedRoute ||
        verifiedRoute.actionNodeId !== asString(message.nodeId) ||
        verifiedRoute.channel !== message.channel ||
        (asString(message.sourceId) &&
          verifiedRoute.sourceId !== asString(message.sourceId)))
    ) {
      throw new Error(
        "Verified generated provenance does not match its persisted message"
      );
    }
    return {
      ordinal,
      messageId,
      message,
      ...(verifiedRoute ? { verifiedRoute } : {}),
    };
  });
  const skipped = new Map<string, GeneratedBulkCampaignSkippedOutcome>();
  const isActive = (work: PreparedWork) => !skipped.has(work.messageId);
  const canonicalReason = (reason: string): string => {
    if (digestMode === "legacy_v2_disabled") return reason;
    if (reason === "whatsapp_marketing_opt_out") return "marketing_opt_out";
    if (reason === "whatsapp_recipient_limit") return "recipient_limit";
    if (reason === "email_unsubscribed") return "unsubscribed";
    if (reason === "prior_failure") return "prior_failure";
    if (
      reason === "marketing_opt_out" ||
      reason === "recent_contact" ||
      reason === "recipient_limit" ||
      reason === "unsubscribed"
    ) {
      return reason;
    }
    return "ineligible";
  };
  const markSkipped = (
    work: PreparedWork,
    reason: string,
    detail?: string | null
  ) => {
    if (!skipped.has(work.messageId)) {
      skipped.set(work.messageId, {
        reason: canonicalReason(reason),
        detail:
          typeof detail === "string" && detail.trim() ? detail.trim() : null,
      });
    }
  };

  // Source/context phase. All source IDs are resolved without truncating root
  // fallbacks; bounded parallelism keeps large malformed lists controlled.
  const whatsappWorks = works.filter(
    work => work.message.channel === "whatsapp"
  );
  const fallbackSourceIds = distinctNonEmpty(input.fallbackSourceIds);
  const explicitWhatsAppSourceIds = distinctNonEmpty(
    whatsappWorks.map(
      work => work.verifiedRoute?.sourceId ?? work.message.sourceId
    )
  );
  const whatsappSourceIdsToResolve = distinctNonEmpty([
    ...explicitWhatsAppSourceIds,
    ...(whatsappWorks.some(
      work => !asString(work.verifiedRoute?.sourceId ?? work.message.sourceId)
    )
      ? fallbackSourceIds
      : []),
  ]);
  const resolvedWhatsAppContexts = await mapInBoundedBatches(
    whatsappSourceIdsToResolve,
    async sourceId => {
      const resolution = await resolveWhatsAppSendContextResult({
        workspaceId,
        sourceId,
      });
      if (!resolution.ok && resolution.kind === "query_error") {
        if (resolution.error instanceof Error) throw resolution.error;
        throw new Error(
          `WhatsApp source query failed for ${sourceId}: ${String(
            resolution.error
          )}`
        );
      }
      return {
        sourceId,
        context: resolution.ok ? resolution.context : null,
      };
    }
  );
  const whatsappContextByRequestedSource = new Map(
    resolvedWhatsAppContexts.map(({ sourceId, context }) => [
      sourceId,
      context &&
      context.workspaceId === workspaceId &&
      context.sourceId === sourceId &&
      asString(context.phoneNumberId) &&
      asString(context.accessToken)
        ? context
        : null,
    ])
  );
  const validFallbackWhatsAppContexts = fallbackSourceIds.flatMap(sourceId => {
    const context = whatsappContextByRequestedSource.get(sourceId);
    return context ? [context] : [];
  });

  for (const work of whatsappWorks) {
    const requestedSourceId = asString(
      work.verifiedRoute?.sourceId ?? work.message.sourceId
    );
    let context = requestedSourceId
      ? whatsappContextByRequestedSource.get(requestedSourceId) || null
      : null;
    if (!requestedSourceId) {
      if (validFallbackWhatsAppContexts.length !== 1) {
        markSkipped(
          work,
          validFallbackWhatsAppContexts.length > 1
            ? "whatsapp_source_ambiguous"
            : "whatsapp_source_missing",
          validFallbackWhatsAppContexts.length > 1
            ? String(validFallbackWhatsAppContexts.length)
            : null
        );
        continue;
      }
      context = validFallbackWhatsAppContexts[0];
    }
    if (!context) {
      if (work.verifiedRoute) {
        throw new Error(
          `Verified generated WhatsApp source ${requestedSourceId || "unknown"} is unavailable`
        );
      }
      markSkipped(
        work,
        "whatsapp_source_unavailable",
        requestedSourceId || null
      );
      continue;
    }

    work.whatsappContext = context;
    work.sourceId = context.sourceId!;
    work.partitionKey = `whatsapp:${context.sourceId}:${context.phoneNumberId}`;
  }

  const telegramWorks = works.filter(
    work => work.message.channel === "telegram"
  );
  const telegramSourceIds = distinctNonEmpty(
    telegramWorks.map(
      work => work.verifiedRoute?.sourceId ?? work.message.sourceId
    )
  );
  const resolvedTelegramContexts = await mapInBoundedBatches(
    telegramSourceIds,
    async sourceId => {
      const resolution = await resolveTelegramSendContextResult({
        workspaceId,
        sourceId,
      });
      if (!resolution.ok && resolution.kind === "query_error") {
        if (resolution.error instanceof Error) throw resolution.error;
        throw new Error(
          `Telegram source query failed for ${sourceId}: ${String(
            resolution.error
          )}`
        );
      }
      return {
        sourceId,
        context: resolution.ok ? resolution.context : null,
      };
    }
  );
  const telegramContextBySourceId = new Map(
    resolvedTelegramContexts.map(({ sourceId, context }) => [
      sourceId,
      context && context.sourceId === sourceId ? context : null,
    ])
  );
  for (const work of telegramWorks) {
    const sourceId = asString(
      work.verifiedRoute?.sourceId ?? work.message.sourceId
    );
    if (!sourceId) {
      markSkipped(work, "telegram_source_missing");
      continue;
    }
    const context = telegramContextBySourceId.get(sourceId);
    if (!context) {
      markSkipped(work, "telegram_source_unavailable", sourceId);
      continue;
    }
    work.sourceId = context.sourceId;
    work.partitionKey = `telegram:${context.sourceId}`;
  }

  const emailWorks = works.filter(work => work.message.channel === "email");
  let emailSendContext: Extract<
    Awaited<ReturnType<typeof resolveEmailBulkSendContextStrict>>,
    { ok: true }
  > | null = null;
  if (emailWorks.length > 0) {
    const emailContext = await resolveEmailBulkSendContextStrict({
      workspaceId,
    });
    if (!emailContext.ok) {
      if (emailContext.kind === "query_error") {
        if (emailContext.error instanceof Error) throw emailContext.error;
        throw new Error(
          `Email source query failed for ${workspaceId}: ${String(
            emailContext.error
          )}`
        );
      }
      emailWorks.forEach(work =>
        markSkipped(work, emailContext.code, emailContext.error)
      );
    } else {
      emailSendContext = emailContext;
      const resolvedEmailSourceId = asString(emailContext.sourceId) || null;
      const providerConfigId = asString(emailContext.providerConfig.id);
      if (!providerConfigId) {
        throw new Error(
          "Email provider configuration is missing its stable identity"
        );
      }
      for (const work of emailWorks) {
        const requestedSourceId = asString(
          work.verifiedRoute?.sourceId ?? work.message.sourceId
        );
        if (requestedSourceId && requestedSourceId !== resolvedEmailSourceId) {
          markSkipped(work, "email_source_unavailable", requestedSourceId);
          continue;
        }
        work.sourceId = resolvedEmailSourceId;
        work.partitionKey = `email:${resolvedEmailSourceId || "workspace"}:${providerConfigId}`;
      }
    }
  }

  // Referenced node/template phase.
  const nodeById = new Map(
    input.nodes.map(nodeValue => [nodeValue.id, nodeValue])
  );
  for (const work of works.filter(isActive)) {
    const nodeValue =
      work.verifiedRoute?.actionNode ||
      nodeById.get(asString(work.message.nodeId));
    if (!nodeValue) {
      markSkipped(work, "missing_action_node", asString(work.message.nodeId));
      continue;
    }
    if (work.message.channel === "whatsapp") {
      assertBulkPrimaryWhatsAppTemplateHasNoConversationBindings(
        nodeValue.data
      );
    }
    work.node = nodeValue;
  }

  const whatsappSourcesNeedingTemplates = distinctNonEmpty(
    whatsappWorks.flatMap(work =>
      isActive(work) && !work.verifiedRoute?.template && work.sourceId
        ? [work.sourceId]
        : []
    )
  );
  const templatesByWhatsAppSource = new Map<string, WhatsAppTemplate[]>();
  const templateCatalogs = await mapInBoundedBatches(
    whatsappSourcesNeedingTemplates,
    async sourceId => {
      try {
        return {
          sourceId,
          templates: await listApprovedWhatsAppTemplatesForSend(workspaceId, {
            sourceId,
          }),
        };
      } catch (error) {
        // Coded like the other template lookups: a Meta throttle is
        // meta_rate_limited, anything else template_lookup_unavailable.
        throw bulkCampaignTemplateLookupError(error);
      }
    }
  );
  templateCatalogs.forEach(({ sourceId, templates }) =>
    templatesByWhatsAppSource.set(sourceId, templates)
  );

  for (const work of whatsappWorks.filter(isActive)) {
    const nodeData = work.node?.data;
    const verifiedTemplate = work.verifiedRoute?.template;
    if (verifiedTemplate) {
      if (!isApprovedWhatsAppCategory(verifiedTemplate.category)) {
        throw new Error("Verified WhatsApp template category is invalid");
      }
      const language = normalizeWhatsAppTemplateLanguageForSend(
        verifiedTemplate.language
      );
      work.whatsappTemplate = {
        id: `verified:${work.messageId}`,
        name: verifiedTemplate.name,
        language,
        status: "APPROVED",
        category: verifiedTemplate.category,
        components: verifiedTemplate.components,
      };
      work.whatsappCategory = verifiedTemplate.category;
      work.whatsappLanguage = language;
      work.whatsappResolvedTemplateComponents =
        mergeComponentsWithUnifiedHeaderMediaUrl({
          metaComponents: verifiedTemplate.components,
          unifiedComponents: normalizeWhatsAppTemplateComponents(
            nodeData?.actionWhatsAppTemplateComponents
          ),
        });
      continue;
    }
    const templateName = asString(nodeData?.actionWhatsAppTemplateName);
    const language =
      normalizeWhatsAppTemplateLanguageForSend(
        nodeData?.actionWhatsAppTemplateLanguage
      ) || "en";
    if (nodeData?.actionType !== "whatsapp_template" || !templateName) {
      markSkipped(
        work,
        "missing_whatsapp_template_fields",
        work.message.nodeId
      );
      continue;
    }
    const template = (
      templatesByWhatsAppSource.get(work.sourceId || "") || []
    ).find(
      candidate =>
        candidate.status === "APPROVED" &&
        approvedTemplateKey(candidate.name, candidate.language) ===
          approvedTemplateKey(templateName, language)
    );
    if (!template || !isApprovedWhatsAppCategory(template.category)) {
      markSkipped(
        work,
        "missing_approved_whatsapp_template",
        `${templateName}:${language}`
      );
      continue;
    }
    work.whatsappTemplate = template;
    work.whatsappCategory = template.category;
    work.whatsappLanguage = language;
    work.whatsappResolvedTemplateComponents =
      mergeComponentsWithUnifiedHeaderMediaUrl({
        metaComponents: template.components as WhatsAppComponent[] | undefined,
        unifiedComponents: normalizeWhatsAppTemplateComponents(
          nodeData?.actionWhatsAppTemplateComponents
        ),
      });
  }
  const hasVerifiedWhatsAppTemplateCapability = input.verifiedRoutes
    ? input.verifiedWhatsAppTemplateCapability === true ||
      input.verifiedRoutes.some(
        route => route.channel === "whatsapp" && Boolean(route.template)
      )
    : whatsappWorks.some(work =>
        Boolean(work.whatsappTemplate && work.whatsappCategory)
      );
  if (
    digestMode === "current_v3" &&
    recipientPolicy.excludePriorFailedBulkSends &&
    (input.verifiedRoutes !== undefined || whatsappWorks.length > 0) &&
    !hasVerifiedWhatsAppTemplateCapability
  ) {
    throw new GeneratedBulkRecipientPolicyUnsupportedError();
  }

  // Payload/media phase.
  for (const work of whatsappWorks.filter(isActive)) {
    const phone = normalizeCampaignPhone(work.message.recipient);
    if (!phone) {
      markSkipped(
        work,
        "invalid_whatsapp_recipient",
        asString(work.message.recipient)
      );
      continue;
    }
    const built = buildWhatsAppTemplateSendComponentsFromTemplate({
      templateComponents: work.whatsappResolvedTemplateComponents,
      values: buildGeneratedTemplateValues(work.message),
      fallbackText: "-",
      createFlowToken: () => `sg:${scenarioId}:${work.messageId}`,
      createQuickReplyPayload: ({ index }) =>
        `sg:${scenarioId}:${work.messageId}:${index}`,
    });
    const missingHeaderMedia = built.issues.find(
      issue => issue.type === "missing_header_media"
    );
    if (missingHeaderMedia) {
      markSkipped(
        work,
        "missing_header_media",
        `${work.message.nodeId}:${missingHeaderMedia.format}`
      );
      continue;
    }
    work.whatsappPhone = phone;
    work.whatsappComponents = built.components;
  }

  for (const work of telegramWorks.filter(isActive)) {
    const chatId = normalizeTelegramChatId(work.message.recipient);
    if (!chatId) {
      markSkipped(work, "missing_chat_id");
      continue;
    }
    if (!asString(work.message.text)) {
      markSkipped(work, "missing_telegram_message_text", chatId);
      continue;
    }
    work.telegramChatId = chatId;
  }

  for (const work of emailWorks.filter(isActive)) {
    const email = normalizeCampaignEmail(work.message.recipient);
    if (!isValidCampaignEmailAddress(email)) {
      markSkipped(
        work,
        "invalid_email_recipient",
        email || work.message.recipient
      );
      continue;
    }
    work.email = email;
  }

  // Consent/history/unsubscribe phase.
  for (const sourceId of distinctNonEmpty(
    whatsappWorks.filter(isActive).map(work => work.sourceId)
  )) {
    const sourceWorks = whatsappWorks.filter(
      work => isActive(work) && work.sourceId === sourceId
    );
    const marketingWorks = sourceWorks.filter(
      work => work.whatsappCategory === "MARKETING"
    );
    if (digestMode === "legacy_v2_disabled" && marketingWorks.length > 0) {
      const result = await filterKnownMarketingOptOutRecipients({
        workspaceId,
        recipients: marketingWorks.map(work => ({
          phone: work.whatsappPhone,
          name: work.message.recipientName || undefined,
          sourceId,
        })),
      });
      const eligiblePhones = new Set(
        result.recipients
          .map(recipient => normalizeCampaignPhone(recipient.phone || ""))
          .filter(Boolean)
      );
      for (const work of marketingWorks) {
        if (!eligiblePhones.has(work.whatsappPhone || "")) {
          markSkipped(work, "whatsapp_marketing_opt_out", work.whatsappPhone);
        }
      }
    }

    const nonMarketingWorks = sourceWorks.filter(
      work => isActive(work) && work.whatsappCategory !== "MARKETING"
    );
    if (nonMarketingWorks.length > 0) {
      const result = await resolveWhatsAppConversationHistoryEligibility({
        workspaceId,
        sourceId,
        phones: nonMarketingWorks.map(work => work.whatsappPhone || ""),
      });
      const eligiblePhones = new Set(result.eligiblePhones);
      for (const work of nonMarketingWorks) {
        if (!eligiblePhones.has(work.whatsappPhone || "")) {
          markSkipped(
            work,
            "whatsapp_conversation_history_required",
            work.whatsappPhone
          );
        }
      }
    }
  }

  for (const sourceId of distinctNonEmpty(
    telegramWorks.filter(isActive).map(work => work.sourceId)
  )) {
    const sourceWorks = telegramWorks.filter(
      work => isActive(work) && work.sourceId === sourceId
    );
    const result = await resolveEligibleTelegramBulkRecipients({
      workspaceId,
      defaultSourceId: sourceId,
      recipients: sourceWorks.map(work => ({
        chatId: work.telegramChatId,
        sourceId,
      })),
    });
    const eligibleByKey = new Map(
      result.recipients.map(recipient => [
        `${normalizeTelegramChatId(recipient.chatId)}:${asString(
          recipient.sourceId
        )}`,
        recipient,
      ])
    );
    const skipByChatId = new Map(
      result.skippedRecipientDetails.flatMap(detail => {
        const chatId = normalizeTelegramChatId(detail.detail);
        return chatId ? [[chatId, detail] as const] : [];
      })
    );
    for (const work of sourceWorks) {
      const recipient = eligibleByKey.get(`${work.telegramChatId}:${sourceId}`);
      if (!recipient) {
        const skippedDetail = skipByChatId.get(work.telegramChatId || "");
        markSkipped(
          work,
          skippedDetail?.reason || "telegram_recipient_not_contacted",
          skippedDetail?.detail || work.telegramChatId
        );
        continue;
      }
      work.telegramBusinessConnectionId =
        asString(recipient.businessConnectionId) || undefined;
    }
  }

  if (emailWorks.some(isActive)) {
    const activeEmailWorks = emailWorks.filter(isActive);
    const result = await filterEmailUnsubscribedRecipients({
      supabase: supabaseAdmin,
      workspaceId,
      recipients: activeEmailWorks.map(work => ({ email: work.email })),
    });
    const eligibleEmails = new Set(
      result.recipients
        .map(recipient => normalizeCampaignEmail(recipient.email || ""))
        .filter(Boolean)
    );
    const skippedReasonByEmail = new Map(
      result.skippedRecipientDetails.map(detail => [detail.detail, detail])
    );
    for (const work of activeEmailWorks) {
      if (!eligibleEmails.has(work.email || "")) {
        const detail = skippedReasonByEmail.get(work.email || "");
        markSkipped(
          work,
          detail?.reason || "email_unsubscribed",
          detail?.detail || work.email
        );
      }
    }
  }

  // Resolve one plan per participating WhatsApp source, then evaluate the
  // persisted policy once over the complete, stable generated order.
  const resolvePlan =
    input.dependencies?.resolvePlan ?? resolveCampaignBatchPlanPreview;
  const planByPartitionKey = new Map<string, CampaignBatchPlanPreview>();
  let whatsappPolicyFacts: PreparedGeneratedWhatsAppPolicyFacts | undefined;
  let whatsappMissingConsentStableIds = new Set<string>();
  if (digestMode === "current_v3" && whatsappWorks.length > 0) {
    const planEligibleWorks = whatsappWorks.filter(work =>
      Boolean(
        work.partitionKey &&
          work.sourceId &&
          work.whatsappContext &&
          work.whatsappTemplate &&
          work.whatsappCategory
      )
    );
    const policyCandidates = whatsappWorks
      .filter(
        work =>
          isActive(work) &&
          Boolean(
            work.partitionKey &&
              work.sourceId &&
              work.whatsappPhone &&
              work.whatsappCategory
          )
      )
      .sort((left, right) => left.ordinal - right.ordinal);

    if (planEligibleWorks.length > 0) {
      const minimumPlan = await resolveMinimumBulkCampaignPlan({
        sourceIds: distinctNonEmpty(
          planEligibleWorks.map(work => work.sourceId)
        ),
        resolvePlan: async ({ sourceId }) => {
          const sourceWork = planEligibleWorks.find(
            work => work.sourceId === sourceId
          );
          if (!sourceWork?.partitionKey || !sourceWork.whatsappContext) {
            throw new Error("WhatsApp source plan is unavailable");
          }
          const preview = await resolvePlan({
            channel: "whatsapp",
            wabaId: sourceWork.whatsappContext.wabaId,
            phoneNumberId: sourceWork.whatsappContext.phoneNumberId,
            accessToken: sourceWork.whatsappContext.accessToken,
            cachedMessagingLimit:
              sourceWork.whatsappContext.cachedMessagingLimit,
          });
          assertCampaignPlanSendingReadiness(preview);
          planByPartitionKey.set(sourceWork.partitionKey, preview);
          return preview;
        },
      });
      const recipientLimit = minimumPlan.recipientLimit.maxRecipients;
      if (!recipientLimit || recipientLimit <= 0) {
        throw new Error("WhatsApp recipient limit is unavailable");
      }
      const evaluateRecipientPolicy =
        input.dependencies?.evaluateRecipientPolicy ??
        evaluateBulkRecipientPolicy;
      const evaluation = await evaluateRecipientPolicy({
        workspaceId,
        channel: "whatsapp",
        candidates: policyCandidates.map(work => ({
          value: work,
          stableId: work.messageId,
          recipient: {
            phone: work.whatsappPhone!,
            sourceId: work.sourceId || undefined,
            name: work.message.recipientName || undefined,
          },
          templateCategory: work.whatsappCategory!,
        })),
        recipientLimit,
        completeness: {
          complete: true,
          uniqueRecipients: new Set(
            policyCandidates.map(work => work.whatsappPhone)
          ).size,
          dispatchItems: policyCandidates.length,
          uniqueRecipientHardCap: GENERATED_BULK_MAX_WHATSAPP_IDENTITIES,
          dispatchItemHardCap: GENERATED_BULK_MAX_ITEMS,
        },
        policy: recipientPolicy,
        ...(recipientPolicy.excludePriorFailedBulkSends
          ? {
              priorFailure: {
                client: supabaseAdmin,
                secret: process.env.ENCRYPTION_SECRET || "",
              },
            }
          : {}),
      });
      const retainedIds = new Set(
        evaluation.retained.map(candidate => candidate.stableId)
      );
      const warningStableIds =
        evaluation.warningStableIds?.missing_marketing_consent ?? [];
      whatsappMissingConsentStableIds = new Set(warningStableIds);
      if (
        whatsappMissingConsentStableIds.size !== warningStableIds.length ||
        warningStableIds.length !==
          evaluation.warnings.missingMarketingConsent ||
        warningStableIds.some(
          stableId =>
            !policyCandidates.some(work => work.messageId === stableId)
        )
      ) {
        throw new Error(
          "Generated WhatsApp policy warning attribution is imbalanced"
        );
      }
      for (const exclusion of evaluation.excluded) {
        markSkipped(
          exclusion.candidate.value,
          exclusion.reason,
          exclusion.reason === "recipient_limit" ? String(recipientLimit) : null
        );
      }
      if (
        evaluation.retained.length + evaluation.excluded.length !==
          policyCandidates.length ||
        policyCandidates.some(
          work => isActive(work) !== retainedIds.has(work.messageId)
        )
      ) {
        throw new Error("Generated WhatsApp policy result is imbalanced");
      }

      const skippedByReason: Partial<Record<BulkCampaignSkipReason, number>> =
        {};
      for (const work of whatsappWorks) {
        const reason = skipped.get(work.messageId)?.reason as
          | BulkCampaignSkipReason
          | undefined;
        if (reason)
          skippedByReason[reason] = (skippedByReason[reason] || 0) + 1;
      }
      whatsappPolicyFacts = {
        policy: recipientPolicy,
        authoritativeRecipientLimit: {
          source: minimumPlan.recipientLimit.source as Exclude<
            typeof minimumPlan.recipientLimit.source,
            "unavailable"
          >,
          value: recipientLimit,
          rawLimit:
            minimumPlan.recipientLimit.rawLimit || String(recipientLimit),
        },
        outcome: accumulateBulkCampaignEligibilityOutcome({
          requestedTotal: whatsappWorks.length,
          acceptedTotal: evaluation.retained.length,
          uniqueRecipients: {
            requested: canonicalWhatsAppIdentities.size,
            accepted: evaluation.uniqueRecipients.accepted,
          },
          stages: [
            {
              skippedByReason,
              warnings: evaluation.warnings,
            },
          ],
        }),
      };
    }
    if (!whatsappPolicyFacts) {
      const skippedByReason: Partial<Record<BulkCampaignSkipReason, number>> =
        {};
      for (const work of whatsappWorks) {
        const reason = skipped.get(work.messageId)?.reason as
          | BulkCampaignSkipReason
          | undefined;
        if (!reason) {
          throw new Error("Generated WhatsApp preflight result is incomplete");
        }
        skippedByReason[reason] = (skippedByReason[reason] || 0) + 1;
      }
      whatsappPolicyFacts = {
        policy: recipientPolicy,
        outcome: accumulateBulkCampaignEligibilityOutcome({
          requestedTotal: whatsappWorks.length,
          acceptedTotal: 0,
          uniqueRecipients: {
            requested: canonicalWhatsAppIdentities.size,
            accepted: 0,
          },
          stages: [
            {
              skippedByReason,
              warnings: { missingMarketingConsent: 0 },
            },
          ],
        }),
      };
    }
  }

  // Recipient-limit phase and final materialization.
  const sourceRequestedCount = new Map<string, number>();
  for (const work of works) {
    if (!work.partitionKey) continue;
    sourceRequestedCount.set(
      work.partitionKey,
      (sourceRequestedCount.get(work.partitionKey) || 0) + 1
    );
  }
  const activePartitionKeys = Array.from(
    new Set(
      works
        .filter(isActive)
        .map(work => work.partitionKey)
        .filter((value): value is string => Boolean(value))
    )
  );
  if (digestMode === "legacy_v2_disabled") {
    activePartitionKeys.sort((left, right) => left.localeCompare(right));
  }
  const partitions: PreparedGeneratedBulkPartition[] = [];
  const appBaseUrl = resolveBulkCampaignAppBaseUrl(input.requestUrl);

  for (const partitionKey of activePartitionKeys) {
    let partitionWorks = works
      .filter(work => isActive(work) && work.partitionKey === partitionKey)
      .sort((left, right) => left.ordinal - right.ordinal);
    const firstWork = partitionWorks[0];
    if (!firstWork) continue;
    const channel = firstWork.message.channel;

    const preview =
      channel === "whatsapp" && digestMode === "current_v3"
        ? planByPartitionKey.get(partitionKey)
        : await resolvePlan({
            channel,
            ...(channel === "whatsapp"
              ? {
                  wabaId: firstWork.whatsappContext?.wabaId,
                  phoneNumberId: firstWork.whatsappContext?.phoneNumberId,
                  accessToken: firstWork.whatsappContext?.accessToken,
                  cachedMessagingLimit:
                    firstWork.whatsappContext?.cachedMessagingLimit,
                }
              : {}),
          });
    if (!preview) {
      throw new Error("Generated bulk campaign plan is unavailable");
    }
    if (channel === "whatsapp" && digestMode === "legacy_v2_disabled") {
      assertCampaignPlanSendingReadiness(preview);
      const recipientLimit = preview.recipientLimit;
      const maxRecipients = recipientLimit.maxRecipients;
      if (!maxRecipients || maxRecipients <= 0) {
        throw new Error(
          recipientLimit.error || "WhatsApp recipient limit is unavailable"
        );
      }
      const acceptedPhones = new Set<string>();
      for (const work of partitionWorks) {
        const phone = work.whatsappPhone || "";
        if (acceptedPhones.has(phone)) continue;
        if (acceptedPhones.size >= maxRecipients) {
          markSkipped(work, "whatsapp_recipient_limit", String(maxRecipients));
          continue;
        }
        acceptedPhones.add(phone);
      }
      // A duplicate for an overflow identity must also remain overflow; only
      // duplicates of an identity admitted on first sight remain candidates.
      const overflowPhones = new Set(
        partitionWorks
          .filter(
            work =>
              skipped.get(work.messageId)?.reason === "whatsapp_recipient_limit"
          )
          .map(work => work.whatsappPhone || "")
      );
      for (const work of partitionWorks) {
        if (
          !skipped.has(work.messageId) &&
          overflowPhones.has(work.whatsappPhone || "")
        ) {
          markSkipped(work, "whatsapp_recipient_limit", String(maxRecipients));
        }
      }
      partitionWorks = partitionWorks.filter(isActive);
    }
    if (partitionWorks.length === 0) continue;

    const campaignId = deriveBulkSendChildCampaignId(operationId, partitionKey);
    const items: BulkCampaignDispatchItem[] = partitionWorks.map(work => {
      const base = {
        workspaceId,
        campaignId: null,
        generatedRecipientMessageId: work.messageId,
        scenarioId,
        scenarioNodeId: work.message.nodeId,
        executionSource: "scenario_run_now" as const,
        sentByUserId,
      };
      if (work.message.channel === "whatsapp") {
        const context = work.whatsappContext!;
        return {
          ...base,
          channel: "whatsapp",
          sourceId: work.sourceId!,
          recipient: {
            phone: work.whatsappPhone!,
            ...(isValidCampaignEmailAddress(
              normalizeCampaignEmail(work.message.recipientEmail || "")
            )
              ? {
                  email: normalizeCampaignEmail(
                    work.message.recipientEmail || ""
                  ),
                }
              : {}),
          },
          phoneNumberId: context.phoneNumberId,
          templateName: work.whatsappTemplate!.name,
          languageCode: work.whatsappLanguage,
          templateCategory: work.whatsappCategory,
          components: work.whatsappComponents,
        };
      }
      if (work.message.channel === "telegram") {
        return {
          ...base,
          channel: "telegram",
          sourceId: work.sourceId!,
          ...(work.telegramBusinessConnectionId
            ? {
                businessConnectionId: work.telegramBusinessConnectionId,
              }
            : {}),
          recipient: { chatId: work.telegramChatId! },
          messageText: asString(work.message.text),
        };
      }

      const email = work.email!;
      const unsubscribeUrl = buildEmailUnsubscribeUrl({
        baseUrl: appBaseUrl,
        workspaceId,
        campaignId,
        email,
      });
      const emailContext = emailSendContext;
      if (!emailContext) {
        throw new Error("Email send context was lost during preparation");
      }
      return {
        ...base,
        channel: "email",
        recipient: {
          email,
          variables: {
            ...buildGeneratedTemplateValues(work.message),
            unsubscribeUrl,
          },
        },
        fromAddress: emailContext.fromAddress,
        templateKey: "announcement",
        templateModel: buildGeneratedEmailTemplateModel({
          campaignName,
          message: work.message,
          unsubscribeUrl,
        }),
        subjectOverride: campaignName,
        messageStream: emailContext.providerConfig.broadcastStream,
      };
    });

    const requestedPartitionWorks = works.filter(
      work => work.partitionKey === partitionKey
    );
    const partitionSkippedByReason: Partial<
      Record<BulkCampaignSkipReason, number>
    > = {};
    for (const work of requestedPartitionWorks) {
      const reason = skipped.get(work.messageId)?.reason as
        | BulkCampaignSkipReason
        | undefined;
      if (reason) {
        partitionSkippedByReason[reason] =
          (partitionSkippedByReason[reason] || 0) + 1;
      }
    }
    const identityForWork = (work: PreparedWork): string | null => {
      if (work.message.channel === "whatsapp") {
        return (
          work.whatsappPhone ||
          normalizeCampaignPhone(work.message.recipient) ||
          null
        );
      }
      if (work.message.channel === "telegram") {
        return (
          work.telegramChatId ||
          normalizeTelegramChatId(work.message.recipient) ||
          null
        );
      }
      const email =
        work.email || normalizeCampaignEmail(work.message.recipient);
      return email || null;
    };
    const authoritativeRecipientLimit =
      firstWork.message.channel === "whatsapp"
        ? whatsappPolicyFacts?.authoritativeRecipientLimit
        : preview.recipientLimit.source !== "unavailable" &&
            preview.recipientLimit.maxRecipients
          ? {
              source: preview.recipientLimit.source,
              value: preview.recipientLimit.maxRecipients,
              rawLimit:
                preview.recipientLimit.rawLimit ||
                String(preview.recipientLimit.maxRecipients),
            }
          : undefined;
    if (digestMode === "current_v3" && !authoritativeRecipientLimit) {
      throw new Error("Generated bulk campaign recipient limit is unavailable");
    }
    const policyOutcome =
      digestMode === "current_v3"
        ? accumulateBulkCampaignEligibilityOutcome({
            requestedTotal: requestedPartitionWorks.length,
            acceptedTotal: partitionWorks.length,
            uniqueRecipients: {
              requested: new Set(
                requestedPartitionWorks.flatMap(work => {
                  const identity = identityForWork(work);
                  return identity ? [identity] : [];
                })
              ).size,
              accepted: new Set(
                partitionWorks.flatMap(work => {
                  const identity = identityForWork(work);
                  return identity ? [identity] : [];
                })
              ).size,
            },
            stages: [
              {
                skippedByReason: partitionSkippedByReason,
                warnings: {
                  missingMarketingConsent:
                    firstWork.message.channel === "whatsapp"
                      ? requestedPartitionWorks.filter(work =>
                          whatsappMissingConsentStableIds.has(work.messageId)
                        ).length
                      : 0,
                },
              },
            ],
          })
        : undefined;

    partitions.push({
      partitionKey,
      channel: firstWork.message.channel,
      sourceId: firstWork.sourceId || null,
      campaignId,
      items,
      candidateMessageIds: partitionWorks.map(work => work.messageId),
      templateName:
        firstWork.message.channel === "whatsapp"
          ? commonValue(partitionWorks.map(work => work.whatsappTemplate?.name))
          : firstWork.message.channel === "email"
            ? "announcement"
            : null,
      templateLanguage:
        firstWork.message.channel === "whatsapp"
          ? commonValue(partitionWorks.map(work => work.whatsappLanguage))
          : firstWork.message.channel === "email"
            ? "en"
            : null,
      messageText:
        firstWork.message.channel === "telegram"
          ? commonValue(partitionWorks.map(work => work.message.text))
          : firstWork.message.channel === "email"
            ? campaignName
            : null,
      batchPlan: preview.batchPlan,
      ...(authoritativeRecipientLimit ? { authoritativeRecipientLimit } : {}),
      ...(policyOutcome ? { policyOutcome } : {}),
      requestedTotal:
        sourceRequestedCount.get(partitionKey) || partitionWorks.length,
      skippedOptIn: works.filter(
        work =>
          work.partitionKey === partitionKey &&
          skipped.get(work.messageId)?.reason ===
            (digestMode === "legacy_v2_disabled"
              ? "whatsapp_marketing_opt_out"
              : "marketing_opt_out")
      ).length,
    });
  }

  const skippedByMessageId = Object.fromEntries(
    requestedMessageIds.flatMap(messageId => {
      const outcome = skipped.get(messageId);
      return outcome ? [[messageId, outcome] as const] : [];
    })
  );
  assertTotalPreparationResult(
    requestedMessageIds,
    partitions,
    skippedByMessageId
  );
  const preparationDigestVersion =
    digestMode === "legacy_v2_disabled"
      ? GENERATED_BULK_LEGACY_PREPARATION_DIGEST_VERSION
      : GENERATED_BULK_PREPARATION_DIGEST_VERSION;
  const preparationDigest = createPreparationDigest({
    version: preparationDigestVersion,
    requestedMessageIds,
    partitions,
    skippedByMessageId,
    works,
    ...(whatsappPolicyFacts ? { whatsappPolicyFacts } : {}),
  });

  return {
    requestedMessageIds,
    partitions,
    skippedByMessageId,
    ...(whatsappPolicyFacts ? { whatsappPolicyFacts } : {}),
    preparationDigestVersion,
    preparationDigest,
  };
}
