import "server-only";
import { mergeBulkCampaignReadiness } from "@icecore/scenario-contracts";

import type {
  BulkCampaignAudienceIntent,
  BulkCampaignEligibilityMessageIntent,
  BulkCampaignRecipientPolicy,
  BulkCampaignReadiness,
  BulkCampaignSkipReason,
} from "@icecore/scenario-contracts";
import type {
  WhatsAppComponent,
  WhatsAppTemplate,
  WhatsAppTemplateCategory,
} from "@icecore/shared/types/whatsapp";
import { normalizeWhatsAppTemplateLanguageCode } from "@icecore/shared/constants/whatsapp-templates";
import {
  MetaGraphRequestError,
  isMetaGraphRateLimitError,
} from "@icecore/shared/lib/meta/api";

import {
  WhatsAppTemplateCatalogError,
  staleWhatsAppTemplateCatalogMissError,
  type WhatsAppTemplateCatalogMetadata,
} from "@/lib/whatsapp/templates/catalog-contracts";

import type { CampaignBatchPlanPreview } from "./campaign-batch-plan";
import type { BulkCampaignRecipient } from "./bulk-campaign-contracts";
import {
  buildCampaignWhatsappRecipientPayload,
  collectCampaignTemplateVariables,
  normalizeCampaignPhone,
} from "./campaign-recipient-utils";
import { resolveWhatsAppConversationHistoryEligibility } from "./whatsapp-bulk-preflight";
import {
  routeVerifiedBulkCampaignProvenance,
  type VerifiedBulkCampaignProvenance,
  type VerifiedBulkCampaignProvenanceCapability,
} from "./bulk-campaign-provenance";
import {
  evaluateBulkRecipientPolicy,
  type BulkRecipientPolicyCandidate,
  type BulkRecipientPolicyCompletenessProof,
  type BulkRecipientPolicyEvaluation,
  type BulkRecipientPolicyInput,
} from "./bulk-recipient-policy";
import { canonicalizeBulkCampaignRecipientIdentity } from "./bulk-campaign-safety";
import { accumulateBulkCampaignEligibilityOutcome } from "./bulk-campaign-outcome";

type WhatsAppTemplateMessageIntent = Extract<
  BulkCampaignEligibilityMessageIntent,
  { kind: "whatsapp_template" }
>;

export type BulkCampaignEligibilityResolvedCandidate<T = unknown> = {
  value: T;
  stableId: string;
  recipient: BulkCampaignRecipient;
};

export type BulkCampaignApprovedTemplateBundle = {
  sourceId: string;
  name: string;
  language: string;
  category: WhatsAppTemplateCategory;
  components: WhatsAppComponent[];
  requiredTemplateVariables: string[];
};

export type BulkCampaignEligibilityCandidate<T = unknown> =
  BulkRecipientPolicyCandidate<T> & {
    approvedTemplate?: BulkCampaignApprovedTemplateBundle;
  };

export type BulkCampaignAudienceCompleteness = Omit<
  BulkRecipientPolicyCompletenessProof,
  "complete"
> & { complete: boolean };

export type BulkCampaignEligibilityPreview = {
  state: "ready";
  evaluatedAt: string;
  requestedTotal: number;
  acceptedTotal: number;
  uniqueRecipients: { requested: number; accepted: number };
  skippedByReason: Partial<Record<BulkCampaignSkipReason, number>>;
  warnings: { missingMarketingConsent: number };
  allExcluded: boolean;
  readiness?: BulkCampaignReadiness;
};

export type BulkCampaignEligibilityResolution<T = unknown> = {
  preview: BulkCampaignEligibilityPreview;
  retained: BulkCampaignEligibilityCandidate<T>[];
  verifiedProvenance: VerifiedBulkCampaignProvenance;
  approvedTemplateCategories: WhatsAppTemplateCategory[];
  plan: CampaignBatchPlanPreview;
};

export type ResolveBulkCampaignRecipientEligibilityInput = {
  workspaceId: string;
  channel: "whatsapp";
  messageIntent: WhatsAppTemplateMessageIntent;
  audience: BulkCampaignAudienceIntent;
  recipientPolicy: BulkCampaignRecipientPolicy;
  provenanceCapability: VerifiedBulkCampaignProvenanceCapability;
  compatibilityTemplateCategoryHint?:
    | "MARKETING"
    | "UTILITY"
    | "AUTHENTICATION";
  approvedTemplateCatalog?: WhatsAppTemplate[];
  /** The freshness of `approvedTemplateCatalog`, when it is a live read. */
  approvedTemplateCatalogMetadata?: WhatsAppTemplateCatalogMetadata;
  campaignId?: string | null;
  observedPlanRevision?: string;
  /**
   * Unique recipients the company's plan still allows (the free bulk
   * recipient allowance); null or absent when unlimited. The send keeps the
   * first ones like the Meta limit does. Callers refuse a send when nothing
   * is left, so this is at least 1.
   */
  recipientAllowance?: number | null;
};

export type ResolveBulkCampaignRecipientEligibilityDependencies<T> = {
  now?: () => Date;
  resolveAudience(input: {
    workspaceId: string;
    audience: BulkCampaignAudienceIntent;
  }): Promise<{
    candidates: BulkCampaignEligibilityResolvedCandidate<T>[];
    completeness: BulkCampaignAudienceCompleteness;
  }>;
  preflight(input: {
    workspaceId: string;
    messageIntent: WhatsAppTemplateMessageIntent;
    candidates: BulkCampaignEligibilityResolvedCandidate<T>[];
    verifiedProvenance: VerifiedBulkCampaignProvenance;
    compatibilityTemplateCategoryHint?:
      | "MARKETING"
      | "UTILITY"
      | "AUTHENTICATION";
    approvedTemplateCatalog?: WhatsAppTemplate[];
    approvedTemplateCatalogMetadata?: WhatsAppTemplateCatalogMetadata;
    campaignId?: string | null;
  }): Promise<{
    candidates: BulkCampaignEligibilityCandidate<T>[];
    excluded: Array<{ stableId: string; reason: "ineligible" }>;
    warnings?: { missingMarketingConsent: number };
    approvedTemplateCategories?: WhatsAppTemplateCategory[];
  }>;
  resolvePlan(input: { sourceId: string }): Promise<CampaignBatchPlanPreview>;
  routeProvenance?: typeof routeVerifiedBulkCampaignProvenance;
  evaluatePolicy?: (
    input: BulkRecipientPolicyInput<T>
  ) => Promise<BulkRecipientPolicyEvaluation<T>>;
  priorFailure?: BulkRecipientPolicyInput<T>["priorFailure"];
};

type EligibilityErrorCode =
  | "incomplete_audience"
  | "hard_cap_exceeded"
  | "invalid_audience"
  | "invalid_preflight"
  | "template_unavailable"
  | "template_lookup_unavailable"
  | "meta_rate_limited"
  | "template_category_conflict"
  | "dispatchability_unavailable"
  | "contact_policy_unavailable"
  | "plan_unavailable";

export class BulkCampaignEligibilityError extends Error {
  /** Seconds until a retry can succeed, when the failure says so. */
  readonly retryAfterSeconds: number | null;

  constructor(
    readonly code: EligibilityErrorCode,
    options?: { cause?: unknown; retryAfterSeconds?: number | null }
  ) {
    super(
      `Bulk campaign eligibility failed: ${code}`,
      options?.cause === undefined ? undefined : { cause: options.cause }
    );
    this.name = "BulkCampaignEligibilityError";
    this.retryAfterSeconds = options?.retryAfterSeconds ?? null;
  }
}

/**
 * A raw Meta throttle carries no recovery time, so clients wait a minute
 * before checking again.
 */
export const BULK_CAMPAIGN_META_RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

/**
 * The longest Retry-After a template cooldown sets. Meta read cooldowns grow
 * to hours, but checking sooner costs no Meta call (the shared catalog
 * answers from its cooldown) and a saved template can pass in the meantime.
 */
export const BULK_CAMPAIGN_META_RATE_LIMIT_MAX_RETRY_AFTER_SECONDS = 15 * 60;

/** Whole seconds until `retryAt`, at least 1 and at most the cap. */
function retryAfterSecondsUntil(retryAt: string | null): number | null {
  const retryAtMs = retryAt ? Date.parse(retryAt) : Number.NaN;
  if (!Number.isFinite(retryAtMs)) return null;
  return Math.min(
    BULK_CAMPAIGN_META_RATE_LIMIT_MAX_RETRY_AFTER_SECONDS,
    Math.max(1, Math.ceil((retryAtMs - Date.now()) / 1_000))
  );
}

/**
 * The one classifier for failed template lookups. The template catalog
 * reports Meta throttling, including an active cooldown that never reaches
 * Meta, as `WHATSAPP_TEMPLATES_RATE_LIMITED` with the time it ends; a raw
 * Graph throttle can still reach here and says nothing about when. Both are
 * `meta_rate_limited`; every other failure is `template_lookup_unavailable`.
 */
export function bulkCampaignTemplateLookupError(
  error: unknown
): BulkCampaignEligibilityError {
  if (error instanceof BulkCampaignEligibilityError) return error;
  const catalogError =
    error instanceof WhatsAppTemplateCatalogError ? error : null;
  const rateLimited = catalogError
    ? catalogError.code === "WHATSAPP_TEMPLATES_RATE_LIMITED"
    : isMetaGraphRateLimitError(error);
  if (!rateLimited) {
    return new BulkCampaignEligibilityError("template_lookup_unavailable", {
      cause: error,
    });
  }
  return new BulkCampaignEligibilityError("meta_rate_limited", {
    cause: error,
    retryAfterSeconds:
      retryAfterSecondsUntil(catalogError?.retryAt ?? null) ??
      BULK_CAMPAIGN_META_RATE_LIMIT_RETRY_AFTER_SECONDS,
  });
}

/**
 * Whether a failure is a template lookup that can clear by itself: any
 * template catalog failure (a Meta throttle or cooldown, an unavailable or
 * incomplete catalog; the catalog also reports network errors this way), a
 * raw Meta throttle or a Graph 5xx. Lost WhatsApp access or a missing source
 * needs someone to fix it, and other errors, such as a failed scenario read,
 * are not template lookups.
 */
export function isTransientBulkCampaignTemplateLookupFailure(
  error: unknown
): boolean {
  if (error instanceof WhatsAppTemplateCatalogError) return true;
  if (isMetaGraphRateLimitError(error)) return true;
  return error instanceof MetaGraphRequestError && error.status >= 500;
}

/** HTTP status for a coded eligibility or recipient-policy failure. */
export function bulkCampaignEligibilityErrorStatus(code: string): number {
  if (code === "template_category_conflict") return 400;
  if (code === "incomplete_audience" || code === "hard_cap_exceeded") {
    return 413;
  }
  return 503;
}

/**
 * Retry delay in seconds for a coded failure that clears by itself (a Meta
 * rate limit), else null. It uses the failure's own recovery time when the
 * lookup knew it.
 */
export function bulkCampaignEligibilityRetryAfterSeconds(error: {
  code: string;
  retryAfterSeconds?: number | null;
}): number | null {
  if (error.code !== "meta_rate_limited") return null;
  return (
    error.retryAfterSeconds ?? BULK_CAMPAIGN_META_RATE_LIMIT_RETRY_AFTER_SECONDS
  );
}

function isApprovedTemplateCategory(
  value: unknown
): value is "MARKETING" | "UTILITY" | "AUTHENTICATION" {
  return (
    value === "MARKETING" || value === "UTILITY" || value === "AUTHENTICATION"
  );
}

function normalizeEligibilityTemplateLanguage(value: string): string {
  return (
    normalizeWhatsAppTemplateLanguageCode(value)?.toLowerCase() ||
    value.trim().replace(/-/g, "_").toLowerCase()
  );
}

export async function preflightBulkCampaignWhatsAppTemplate<T>(input: {
  workspaceId: string;
  messageIntent: WhatsAppTemplateMessageIntent;
  candidates: BulkCampaignEligibilityResolvedCandidate<T>[];
  verifiedProvenance: VerifiedBulkCampaignProvenance;
  compatibilityTemplateCategoryHint?:
    | "MARKETING"
    | "UTILITY"
    | "AUTHENTICATION";
  approvedTemplateCatalog?: WhatsAppTemplate[];
  approvedTemplateCatalogMetadata?: WhatsAppTemplateCatalogMetadata;
  campaignId?: string | null;
}): Promise<{
  candidates: BulkCampaignEligibilityCandidate<T>[];
  excluded: Array<{ stableId: string; reason: "ineligible" }>;
  warnings: { missingMarketingConsent: number };
  approvedTemplateCategories: WhatsAppTemplateCategory[];
}> {
  const routeByStableId = new Map(
    input.verifiedProvenance.routes.map(route => [
      route.recipientStableId,
      route,
    ])
  );
  const needsFallbackTemplate = input.candidates.some(
    candidate => !routeByStableId.get(candidate.stableId)?.template
  );
  const fallbackTemplateByKey = new Map<
    string,
    {
      name: string;
      language: string;
      category: WhatsAppTemplateCategory;
      components?: WhatsAppComponent[];
    }
  >();
  if (needsFallbackTemplate) {
    const fallbackIdentities = input.candidates.flatMap(candidate => {
      if (routeByStableId.get(candidate.stableId)?.template) return [];
      return [
        {
          name:
            candidate.recipient.templateName?.trim() ||
            input.messageIntent.templateName,
          language:
            candidate.recipient.languageCode?.trim() ||
            input.messageIntent.language,
        },
      ];
    });
    const fallbackKeys = Array.from(
      new Set(
        fallbackIdentities.map(identity =>
          [
            identity.name,
            normalizeEligibilityTemplateLanguage(identity.language),
          ].join("::")
        )
      )
    );
    let catalog: WhatsAppTemplateCatalogMetadata | undefined;
    if (input.approvedTemplateCatalog) {
      catalog = input.approvedTemplateCatalogMetadata;
      for (const template of input.approvedTemplateCatalog) {
        if (template.status !== "APPROVED") continue;
        fallbackTemplateByKey.set(
          [
            template.name,
            normalizeEligibilityTemplateLanguage(template.language),
          ].join("::"),
          template
        );
      }
    } else {
      try {
        const sendLookup = await import("@/lib/whatsapp/templates/send-lookup");
        if (fallbackKeys.length === 1) {
          const [name, language] = fallbackKeys[0]!.split("::");
          const resolved =
            await sendLookup.resolveApprovedWhatsAppTemplateForSend({
              workspaceId: input.workspaceId,
              sourceId: input.messageIntent.sourceId,
              templateName: name!,
              languageCode: language!,
            });
          catalog = resolved.catalog;
          if (resolved.template) {
            fallbackTemplateByKey.set(fallbackKeys[0]!, resolved.template);
          }
        } else {
          const result = await sendLookup.readApprovedWhatsAppTemplatesForSend(
            input.workspaceId,
            { sourceId: input.messageIntent.sourceId }
          );
          catalog = result.catalog;
          for (const template of result.templates) {
            if (template.status !== "APPROVED") continue;
            fallbackTemplateByKey.set(
              [
                template.name,
                normalizeEligibilityTemplateLanguage(template.language),
              ].join("::"),
              template
            );
          }
        }
      } catch (error) {
        throw bulkCampaignTemplateLookupError(error);
      }
    }
    // A stale catalog can miss a template Meta has, so a miss there is a
    // failed lookup, not a template that isn't approved.
    const staleMiss = fallbackKeys.some(key => !fallbackTemplateByKey.has(key))
      ? staleWhatsAppTemplateCatalogMissError(catalog)
      : null;
    if (staleMiss) throw bulkCampaignTemplateLookupError(staleMiss);
  }

  const candidates: BulkCampaignEligibilityCandidate<T>[] = [];
  const excluded: Array<{ stableId: string; reason: "ineligible" }> = [];
  const approvedTemplateCategories = new Set<WhatsAppTemplateCategory>();
  for (const candidate of input.candidates) {
    const route = routeByStableId.get(candidate.stableId);
    const fallbackKey = [
      candidate.recipient.templateName?.trim() ||
        input.messageIntent.templateName,
      normalizeEligibilityTemplateLanguage(
        candidate.recipient.languageCode?.trim() || input.messageIntent.language
      ),
    ].join("::");
    const approvedTemplate =
      route?.template || fallbackTemplateByKey.get(fallbackKey);
    const category = approvedTemplate?.category;
    if (!approvedTemplate || !isApprovedTemplateCategory(category)) {
      throw new BulkCampaignEligibilityError("template_unavailable");
    }
    if (
      input.compatibilityTemplateCategoryHint &&
      input.compatibilityTemplateCategoryHint !== category
    ) {
      throw new BulkCampaignEligibilityError("template_category_conflict");
    }
    approvedTemplateCategories.add(category);
    const requiredTemplateVariables = collectCampaignTemplateVariables(
      approvedTemplate.components
    );
    const payload = buildCampaignWhatsappRecipientPayload({
      workspaceId: input.workspaceId,
      campaignId: input.campaignId || "{campaignId}",
      scenarioId: input.verifiedProvenance.scenarioId,
      scenarioNodeId: route?.actionNodeId,
      scenarioStepTemplate: route?.stepTemplate,
      recipient: candidate.recipient,
      sourceId: route?.sourceId || input.messageIntent.sourceId,
      templateName: approvedTemplate.name,
      templateComponents: approvedTemplate.components,
      requiredTemplateVariables,
      strictRequiredTemplateVariables: true,
    });
    if (payload.missingRequired.length > 0 || payload.headerMediaMissing) {
      excluded.push({ stableId: candidate.stableId, reason: "ineligible" });
      continue;
    }
    const sourceId = route?.sourceId || input.messageIntent.sourceId;
    candidates.push({
      ...candidate,
      templateCategory: category,
      approvedTemplate: {
        sourceId,
        name: approvedTemplate.name,
        language: approvedTemplate.language,
        category,
        components: structuredClone(approvedTemplate.components || []),
        requiredTemplateVariables,
      },
    });
  }

  const nonMarketingCandidatesBySource = new Map<
    string,
    BulkCampaignEligibilityCandidate<T>[]
  >();
  for (const candidate of candidates) {
    if (candidate.templateCategory === "MARKETING") continue;
    const route = routeByStableId.get(candidate.stableId);
    const sourceId =
      candidate.approvedTemplate?.sourceId ||
      route?.sourceId ||
      input.messageIntent.sourceId;
    const grouped = nonMarketingCandidatesBySource.get(sourceId) || [];
    grouped.push(candidate);
    nonMarketingCandidatesBySource.set(sourceId, grouped);
  }
  const historyIneligibleIds = new Set<string>();
  try {
    await Promise.all(
      Array.from(nonMarketingCandidatesBySource.entries()).map(
        async ([sourceId, grouped]) => {
          const result = await resolveWhatsAppConversationHistoryEligibility({
            workspaceId: input.workspaceId,
            sourceId,
            phones: grouped.flatMap(candidate =>
              candidate.recipient.phone
                ? [normalizeCampaignPhone(candidate.recipient.phone)]
                : []
            ),
          });
          const skippedPhones = new Set(result.skippedPhones);
          for (const candidate of grouped) {
            const phone = normalizeCampaignPhone(
              candidate.recipient.phone || ""
            );
            if (skippedPhones.has(phone)) {
              historyIneligibleIds.add(candidate.stableId);
            }
          }
        }
      )
    );
  } catch (error) {
    throw new BulkCampaignEligibilityError("dispatchability_unavailable", {
      cause: error,
    });
  }
  for (const stableId of historyIneligibleIds) {
    excluded.push({ stableId, reason: "ineligible" });
  }

  return {
    candidates: candidates.filter(
      candidate => !historyIneligibleIds.has(candidate.stableId)
    ),
    excluded,
    warnings: { missingMarketingConsent: 0 },
    approvedTemplateCategories: Array.from(approvedTemplateCategories),
  };
}

export async function resolveBulkCampaignWhatsAppPlan(input: {
  workspaceId: string;
  sourceId: string;
}): Promise<CampaignBatchPlanPreview> {
  const [{ resolveWhatsAppSendContext }, { resolveCampaignBatchPlanPreview }] =
    await Promise.all([
      import("@/lib/whatsapp/send-context"),
      import("./campaign-batch-plan"),
    ]);
  const sendContext = await resolveWhatsAppSendContext({
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
  });
  if (
    !sendContext ||
    sendContext.sourceId !== input.sourceId ||
    !sendContext.phoneNumberId ||
    !sendContext.accessToken
  ) {
    throw new BulkCampaignEligibilityError("plan_unavailable");
  }
  return resolveCampaignBatchPlanPreview({
    channel: "whatsapp",
    wabaId: sendContext.wabaId,
    phoneNumberId: sendContext.phoneNumberId,
    accessToken: sendContext.accessToken,
    cachedMessagingLimit: sendContext.cachedMessagingLimit,
  });
}

function validateResolvedAudience<T>(input: {
  candidates: readonly BulkCampaignEligibilityResolvedCandidate<T>[];
  completeness: BulkCampaignAudienceCompleteness;
}): string[] {
  const proof = input.completeness;
  if (!proof.complete) {
    throw new BulkCampaignEligibilityError("incomplete_audience");
  }
  const integerFields = [
    proof.uniqueRecipients,
    proof.dispatchItems,
    proof.uniqueRecipientHardCap,
    proof.dispatchItemHardCap,
  ];
  if (
    integerFields.some(value => !Number.isInteger(value) || value < 0) ||
    proof.uniqueRecipientHardCap <= 0 ||
    proof.dispatchItemHardCap <= 0 ||
    proof.dispatchItems !== input.candidates.length
  ) {
    throw new BulkCampaignEligibilityError("invalid_audience");
  }
  if (
    proof.uniqueRecipients > proof.uniqueRecipientHardCap ||
    proof.dispatchItems > proof.dispatchItemHardCap
  ) {
    throw new BulkCampaignEligibilityError("hard_cap_exceeded");
  }
  const stableIds = input.candidates.map(candidate =>
    candidate.stableId.trim()
  );
  if (
    stableIds.some(stableId => !stableId) ||
    new Set(stableIds).size !== stableIds.length
  ) {
    throw new BulkCampaignEligibilityError("invalid_audience");
  }
  const identities = input.candidates.map(candidate =>
    canonicalizeBulkCampaignRecipientIdentity({
      channel: "whatsapp",
      recipient: candidate.recipient,
    })
  );
  if (
    identities.some(identity => !identity) ||
    new Set(identities).size !== proof.uniqueRecipients
  ) {
    throw new BulkCampaignEligibilityError("invalid_audience");
  }
  return identities as string[];
}

function validatePreflight<T>(input: {
  resolved: readonly BulkCampaignEligibilityResolvedCandidate<T>[];
  retained: readonly BulkCampaignEligibilityCandidate<T>[];
  excluded: readonly { stableId: string; reason: "ineligible" }[];
}): void {
  const resolvedIds = new Set(
    input.resolved.map(candidate => candidate.stableId)
  );
  const retainedIds = input.retained.map(candidate => candidate.stableId);
  const excludedIds = input.excluded.map(candidate => candidate.stableId);
  const allIds = [...retainedIds, ...excludedIds];
  if (
    new Set(allIds).size !== allIds.length ||
    allIds.length !== input.resolved.length ||
    allIds.some(stableId => !resolvedIds.has(stableId)) ||
    input.retained.some(
      candidate =>
        candidate.templateCategory !== "MARKETING" &&
        candidate.templateCategory !== "UTILITY" &&
        candidate.templateCategory !== "AUTHENTICATION"
    )
  ) {
    throw new BulkCampaignEligibilityError("invalid_preflight");
  }
}

function requireUsableRecipientLimit(plan: CampaignBatchPlanPreview): number {
  const limit = plan.recipientLimit.maxRecipients;
  if (
    plan.recipientLimit.source === "unavailable" ||
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit <= 0
  ) {
    throw new BulkCampaignEligibilityError("plan_unavailable");
  }
  return limit;
}

export async function resolveMinimumBulkCampaignPlan(input: {
  sourceIds: readonly string[];
  resolvePlan(params: { sourceId: string }): Promise<CampaignBatchPlanPreview>;
}): Promise<CampaignBatchPlanPreview> {
  const sourceIds = Array.from(
    new Set(
      input.sourceIds.flatMap(sourceId => {
        const trimmed = sourceId.trim();
        return trimmed ? [trimmed] : [];
      })
    )
  );
  if (sourceIds.length === 0) {
    throw new BulkCampaignEligibilityError("plan_unavailable");
  }
  const plans = await Promise.all(
    sourceIds.map(sourceId => input.resolvePlan({ sourceId }))
  );
  let selected: CampaignBatchPlanPreview | null = null;
  let selectedLimit = 0;
  for (const plan of plans) {
    const limit = requireUsableRecipientLimit(plan);
    if (!selected || limit < selectedLimit) {
      selected = plan;
      selectedLimit = limit;
    }
  }
  if (!selected) throw new BulkCampaignEligibilityError("plan_unavailable");
  return {
    ...selected,
    readiness: mergeBulkCampaignReadiness(plans.map(plan => plan.readiness)),
  };
}

export async function resolveBulkCampaignRecipientEligibility<T>(
  input: ResolveBulkCampaignRecipientEligibilityInput,
  dependencies: ResolveBulkCampaignRecipientEligibilityDependencies<T>
): Promise<BulkCampaignEligibilityResolution<T>> {
  const resolvedAudience = await dependencies.resolveAudience({
    workspaceId: input.workspaceId,
    audience: input.audience,
  });
  validateResolvedAudience(resolvedAudience);

  const routeProvenance =
    dependencies.routeProvenance || routeVerifiedBulkCampaignProvenance;
  const verifiedProvenance = routeProvenance(
    input.provenanceCapability,
    resolvedAudience.candidates.map(candidate => ({
      stableId: candidate.stableId,
      recipient: candidate.recipient,
    }))
  );
  const preflight = await dependencies.preflight({
    workspaceId: input.workspaceId,
    messageIntent: input.messageIntent,
    candidates: resolvedAudience.candidates,
    verifiedProvenance,
    compatibilityTemplateCategoryHint: verifiedProvenance.columnSplitNodeId
      ? undefined
      : input.compatibilityTemplateCategoryHint,
    approvedTemplateCatalog: input.approvedTemplateCatalog,
    approvedTemplateCatalogMetadata: input.approvedTemplateCatalogMetadata,
    campaignId: input.campaignId,
  });
  validatePreflight({
    resolved: resolvedAudience.candidates,
    retained: preflight.candidates,
    excluded: preflight.excluded,
  });

  const preflightStableIds = new Set(
    preflight.candidates.map(candidate => candidate.stableId)
  );
  const verifiedSourceIds: string[] = [];
  for (const route of verifiedProvenance.routes) {
    if (!preflightStableIds.has(route.recipientStableId) || !route.sourceId) {
      continue;
    }
    verifiedSourceIds.push(route.sourceId);
  }
  const sourceIds =
    verifiedSourceIds.length > 0
      ? verifiedSourceIds
      : [input.messageIntent.sourceId];
  const plan = await resolveMinimumBulkCampaignPlan({
    sourceIds,
    resolvePlan: dependencies.resolvePlan,
  });

  const preflightUniqueRecipients = new Set(
    preflight.candidates.map(candidate =>
      canonicalizeBulkCampaignRecipientIdentity({
        channel: "whatsapp",
        recipient: candidate.recipient,
      })
    )
  ).size;
  const evaluatePolicy =
    dependencies.evaluatePolicy || evaluateBulkRecipientPolicy;
  const uniqueRecipientLimit = Math.min(
    resolvedAudience.completeness.uniqueRecipientHardCap,
    requireUsableRecipientLimit(plan),
    input.recipientAllowance ?? Number.POSITIVE_INFINITY
  );
  // One clock for the contact windows the policy judges and the preview time.
  const evaluatedAt = (dependencies.now || (() => new Date()))();
  const policy = await evaluatePolicy({
    workspaceId: input.workspaceId,
    channel: "whatsapp",
    candidates: preflight.candidates,
    recipientLimit: uniqueRecipientLimit,
    completeness: {
      complete: true,
      uniqueRecipients: preflightUniqueRecipients,
      dispatchItems: preflight.candidates.length,
      uniqueRecipientHardCap:
        resolvedAudience.completeness.uniqueRecipientHardCap,
      dispatchItemHardCap: resolvedAudience.completeness.dispatchItemHardCap,
    },
    policy: input.recipientPolicy,
    now: evaluatedAt,
    priorFailure: dependencies.priorFailure,
  });

  const accumulated = accumulateBulkCampaignEligibilityOutcome({
    requestedTotal: resolvedAudience.candidates.length,
    acceptedTotal: policy.retained.length,
    uniqueRecipients: {
      requested: resolvedAudience.completeness.uniqueRecipients,
      accepted: policy.uniqueRecipients.accepted,
    },
    stages: [
      {
        skippedByReason: { ineligible: preflight.excluded.length },
        warnings: preflight.warnings || { missingMarketingConsent: 0 },
      },
      {
        skippedByReason: policy.skippedByReason,
        warnings: policy.warnings,
      },
    ],
  });

  return {
    preview: {
      state: "ready",
      evaluatedAt: evaluatedAt.toISOString(),
      ...accumulated,
      // Recently contacted recipients are skipped by the policy, so the
      // contact policy no longer blocks the whole send.
      readiness: plan.readiness,
    },
    retained: policy.retained,
    verifiedProvenance,
    approvedTemplateCategories:
      preflight.approvedTemplateCategories ||
      Array.from(
        new Set(
          preflight.candidates.flatMap(candidate =>
            candidate.approvedTemplate
              ? [candidate.approvedTemplate.category]
              : []
          )
        )
      ),
    plan,
  };
}
