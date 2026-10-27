import { randomUUID } from "node:crypto";

import {
  BulkAnalyticsAudienceUnavailableError,
  resolveBulkAnalyticsAudience,
  type BulkAnalyticsAudienceRecipient,
} from "@/lib/analytics/bulk-analytics-audience";
import type {
  BulkAnalyticsVariableSourceConfig,
  BulkAnalyticsVariableSourceMode,
} from "@/lib/analytics/bulk-analytics-contract";
import {
  completeLegacyBulkSendOperation,
  createLegacyBulkSendRequestDigest,
  deriveBulkSendCampaignId,
  releaseLegacyBulkSendOperation,
  reserveLegacyBulkSendOperation,
} from "@/lib/campaign/bulk-send-api-idempotency";
import {
  captureBulkSendFunnelOutcome,
  type BulkSendAnalyticsContext,
} from "@/lib/campaign/bulk-send-funnel";
import {
  filterEmailUnsubscribedRecipients,
  resolveBulkCampaignAppBaseUrl,
  resolveEmailBulkSendContext,
  type EmailBulkSendContext,
} from "@/lib/campaign/email-bulk-preflight";
import {
  resolveEligibleTelegramBulkRecipients,
  type ResolvedTelegramBulkCampaignRecipient,
} from "@/lib/campaign/telegram-bulk-preflight";
import { resolveWhatsAppServiceWindowEligibility } from "@/lib/campaign/whatsapp-bulk-preflight";
import { hasStoredTelegramBotToken } from "@/lib/integrations/source-status";
import connectDB from "@/lib/mongoose";
import type { ScenarioGraphNodeLike } from "@/lib/scenarios/graph-validation";
import {
  ScenarioOperationError,
  type ScenarioOperationFailure,
} from "@/lib/scenarios/scenario-operation-error";
import { normalizeScenarioRevision } from "@/lib/scenarios/scenario-revision";
import { saveScenario } from "@/lib/scenarios/scenario-save";
import { normalizeBulkSendScheduledAt } from "@/lib/campaign/bulk-send-schedule";
import {
  buildCompanyBulkRecipientLimitExceededResponse,
  buildCompanyLimitExceededResponse,
  ensureCompanyConversationCapacity,
  readCompanyBulkRecipientAllowance,
} from "@/lib/limits/company-limits";
import { resolveCampaignBatchPlanPreview } from "@/lib/campaign/campaign-batch-plan";
import {
  createPreparedBulkCampaignTerminalReplayError,
  ensureAdmittedBulkCampaignReplayStarted,
  PreparedBulkCampaignQueueError,
  queuePreparedBulkCampaignDispatch,
} from "@/lib/campaign/queue-prepared-bulk-campaign-dispatch";
import {
  buildCampaignEmailTemplateModel,
  buildCampaignWhatsappRecipientPayload,
  isValidCampaignEmailAddress,
  normalizeCampaignEmail,
  normalizeCampaignPhone,
  personalizeCampaignTelegramMessage,
  resolveCampaignRecipientContactName,
  type CampaignScenarioStepTemplate,
} from "@/lib/campaign/campaign-recipient-utils";
import { mergeCampaignRecipientsWithFillUp } from "@/lib/campaign/campaign-recipient-fill-up";
import {
  isRegisteredUsersEmailAudienceEnabledForWorkspace,
  resolveRegisteredUsersEmailAudience,
} from "@/lib/email/registered-users-audience";
import { resolveRegisteredBusinessPhoneAudience } from "@/lib/customers/registration-contact";
import { resolveTelegramSubscribersAudience } from "@/lib/telegram/subscribers";
import { normalizeTelegramChatId } from "@/lib/telegram/chat-id";
import { buildEmailUnsubscribeUrl } from "@/lib/email/email-unsubscribes";
import {
  DEFAULT_EMAIL_CAMPAIGN_LOCALE,
  normalizeEmailCampaignLocale,
  type EmailCampaignLocale,
} from "@/lib/email/email-campaign-locales";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isTemporalConfigured } from "@/lib/temporal/client";
import { isWorkspaceFeatureEnabled } from "@/lib/workspace-feature-flags";
import { resolveWhatsAppSendContext } from "@/lib/whatsapp/send-context";
import { hasWhatsAppQrGraphBinding } from "@/lib/whatsapp/qr-entry-points/scenario-binding";
import {
  normalizeWhatsAppTemplateHeaderMediaComponents,
  type WhatsAppHeaderMediaUploadCache,
} from "@/lib/whatsapp/templates/header-media";
import type { WhatsAppTemplateCatalogMetadata } from "@/lib/whatsapp/templates/catalog-contracts";
import {
  readApprovedWhatsAppTemplatesForSend,
  resolveApprovedWhatsAppTemplateForSend,
} from "@/lib/whatsapp/templates/send-lookup";
import { Scenario } from "@/models/scenario";
import {
  BULK_CAMPAIGN_DISPATCH_EXECUTION_SOURCES,
  SCENARIO_BULK_REGISTERED_BUSINESS_PHONES_AUDIENCE_SOURCE,
  SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE,
  type BulkCampaignDispatchExecutionSource,
} from "@icecore/scenario-contracts";
import {
  buildBulkCampaignDispatchLogicalRecipientKey,
  type BulkCampaignDispatchItem,
} from "@icecore/temporal";
import type {
  WhatsAppComponent,
  WhatsAppTemplate,
} from "@icecore/shared/types/whatsapp";
import {
  MAX_BULK_CAMPAIGN_RECIPIENTS,
  parseBulkCampaignSendRequest,
  type BulkCampaignRecipient,
  type EmailCampaignContent,
} from "@/lib/campaign/bulk-campaign-contracts";
import {
  BulkCampaignEligibilityError,
  bulkCampaignEligibilityErrorStatus,
  bulkCampaignEligibilityRetryAfterSeconds,
  bulkCampaignTemplateLookupError,
  isTransientBulkCampaignTemplateLookupFailure,
  preflightBulkCampaignWhatsAppTemplate,
  resolveBulkCampaignRecipientEligibility,
  resolveBulkCampaignWhatsAppPlan,
  type BulkCampaignEligibilityResolution,
} from "@/lib/campaign/bulk-campaign-recipient-eligibility";
import {
  accumulateBulkCampaignEligibilityOutcome,
  createBulkCampaignErrorResult,
  createBulkCampaignSuccessResult,
  projectBulkCampaignReplayResponse,
  serializeBulkCampaignCommandResult,
} from "@/lib/campaign/bulk-campaign-outcome";
import {
  BulkCampaignAdmissionPayloadMismatchError,
  BulkCampaignAdmissionUnavailableError,
  lookupAdmittedBulkCampaignReplay,
  type BulkCampaignPolicyAdmissionMetadata,
  type BulkCampaignReplayLookupClient,
} from "@/lib/campaign/bulk-campaign-admission";
import {
  BULK_CAMPAIGN_OVERFLOW_QUEUE_CONFIRMATION_REQUIRED,
  buildBulkCampaignOverflowQueuePlan,
} from "@/lib/campaign/bulk-campaign-overflow-queue";
import {
  createBulkCampaignAdmittedReplayPolicyEventFacts,
  createBulkCampaignTerminalReplayFactsUnavailableEvent,
  createBulkCampaignTerminalReplayPolicyEvent,
  emitBulkCampaignPolicyEvent,
  parseBulkCampaignPersistedPolicyEventFacts,
  type BulkCampaignPolicyEvent,
} from "@/lib/campaign/bulk-campaign-observability";
import {
  BulkCampaignProvenanceError,
  verifyBulkCampaignProvenanceCapability,
  type VerifiedBulkCampaignProvenanceCapability,
} from "@/lib/campaign/bulk-campaign-provenance";
import { canonicalizeBulkCampaignRecipientIdentity } from "@/lib/campaign/bulk-campaign-safety";
import { BulkRecipientPolicyError } from "@/lib/campaign/bulk-recipient-policy";
import { logBulkCampaignEligibilityFailure } from "@/lib/campaign/bulk-campaign-eligibility-response";
import { partitionRecentlyContactedRecipients } from "@/lib/campaign/customer-contact-policy";
import { isWorkspaceManagerRole } from "@/lib/supabase/company-users";
import { logger } from "@/lib/logger";
import { Types } from "mongoose";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  firstOrSelf,
  readStringOrEmpty,
} from "@icecore/shared/lib/value-utils";

export const maxDuration = 300;

function bulkCampaignIdempotencyPayloadMismatchResponse(): NextResponse {
  return NextResponse.json(
    {
      code: "bulk_campaign_idempotency_payload_mismatch",
      error: "This idempotency key is already bound to a different request.",
      retryable: false,
    },
    { status: 409 }
  );
}

function bulkCampaignIdempotencyUnavailableResponse(
  action: "recovered" | "committed"
): NextResponse {
  return NextResponse.json(
    {
      code: "bulk_campaign_idempotency_unavailable",
      error: `Bulk campaign result could not be ${action} safely. Retry.`,
      retryable: true,
    },
    { status: 503 }
  );
}

type BulkCampaignEventFacts = Omit<
  BulkCampaignPolicyEvent,
  "workspaceId" | "idempotentReplay"
>;

const CampaignHistoryCreateInputSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  channel: z.enum(["whatsapp", "telegram", "email"]),
  templateName: z.string().trim().min(1).nullable(),
  templateLanguage: z.string().trim().min(1).max(32),
  messageText: z.string().trim().min(1).max(100_000).nullable(),
  totalRecipients: z.number().int().nonnegative(),
  sentBy: z.string().trim().min(1).nullable(),
  scenarioId: z.string().trim().min(1).nullable(),
  scenarioNodeId: z.string().trim().min(1).nullable(),
  executionSource: z.enum(
    BULK_CAMPAIGN_DISPATCH_EXECUTION_SOURCES as unknown as [
      BulkCampaignDispatchExecutionSource,
      ...BulkCampaignDispatchExecutionSource[],
    ]
  ),
});

type EmailCampaignContentByLocale = Partial<
  Record<EmailCampaignLocale, EmailCampaignContent>
>;

function readUntrustedRecipientCompatibilityHint(
  recipient: unknown,
  key: "languageCode" | "templateName"
): string {
  if (!recipient || typeof recipient !== "object" || Array.isArray(recipient)) {
    return "";
  }
  const value = (recipient as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

function resolveDefaultEmailContent(params: {
  emailContent?: EmailCampaignContent;
  emailContentByLocale?: EmailCampaignContentByLocale;
}): EmailCampaignContent | undefined {
  if (params.emailContent) return params.emailContent;
  if (params.emailContentByLocale?.[DEFAULT_EMAIL_CAMPAIGN_LOCALE]) {
    return params.emailContentByLocale[DEFAULT_EMAIL_CAMPAIGN_LOCALE];
  }
  return Object.values(params.emailContentByLocale || {}).find(Boolean);
}

function hasLocalizedEmailContent(
  emailContentByLocale?: EmailCampaignContentByLocale
): boolean {
  return Boolean(
    emailContentByLocale &&
      Object.entries(emailContentByLocale).some(
        ([locale, content]) =>
          locale !== DEFAULT_EMAIL_CAMPAIGN_LOCALE && Boolean(content)
      )
  );
}

function resolveRecipientEmailLocale(
  recipient: BulkCampaignRecipient
): EmailCampaignLocale {
  const variables = recipient.variables || {};
  const fields = recipient.fields || {};
  return (
    normalizeEmailCampaignLocale(variables.locale) ||
    normalizeEmailCampaignLocale(variables.language) ||
    normalizeEmailCampaignLocale(variables.lang) ||
    normalizeEmailCampaignLocale(variables.airi_language) ||
    normalizeEmailCampaignLocale(fields.locale) ||
    normalizeEmailCampaignLocale(fields.language) ||
    normalizeEmailCampaignLocale(fields.lang) ||
    normalizeEmailCampaignLocale(fields.airi_language) ||
    DEFAULT_EMAIL_CAMPAIGN_LOCALE
  );
}

function resolveEmailContentForRecipient(params: {
  defaultContent?: EmailCampaignContent;
  emailContentByLocale?: EmailCampaignContentByLocale;
  locale: EmailCampaignLocale;
}): EmailCampaignContent | undefined {
  return params.emailContentByLocale?.[params.locale] || params.defaultContent;
}

function resolveBulkSendWhatsappPayload(
  recipient: BulkCampaignRecipient,
  templateComponents: WhatsAppComponent[] | undefined,
  requiredTemplateVariables: string[],
  workspaceId: string,
  campaignId: string | null,
  scenarioId: string | null,
  scenarioNodeId: string | null,
  sourceId: string | null,
  templateName: string | null,
  scenarioStepTemplate?: CampaignScenarioStepTemplate
) {
  return buildCampaignWhatsappRecipientPayload({
    recipient,
    templateComponents,
    requiredTemplateVariables,
    workspaceId,
    campaignId,
    scenarioId,
    scenarioNodeId,
    scenarioStepTemplate,
    sourceId,
    templateName,
    strictRequiredTemplateVariables: true,
  });
}

function retainBulkCampaignRecipientsWithinUniqueLimit(params: {
  channel: "whatsapp" | "telegram" | "email";
  recipients: BulkCampaignRecipient[];
  maxUniqueRecipients: number;
}): { recipients: BulkCampaignRecipient[]; skipped: number } {
  const admittedIdentities = new Set<string>();
  const recipients: BulkCampaignRecipient[] = [];
  let skipped = 0;
  for (const recipient of params.recipients) {
    const identity = canonicalizeBulkCampaignRecipientIdentity({
      channel: params.channel,
      recipient,
    });
    if (!identity || admittedIdentities.has(identity)) {
      recipients.push(recipient);
      continue;
    }
    if (admittedIdentities.size >= params.maxUniqueRecipients) {
      skipped += 1;
      continue;
    }
    admittedIdentities.add(identity);
    recipients.push(recipient);
  }
  return { recipients, skipped };
}

function resolveAnalyticsAudienceVariable(params: {
  recipient: BulkAnalyticsAudienceRecipient;
  mode: BulkAnalyticsVariableSourceMode;
  customValue?: string;
}): string {
  if (params.mode === "custom") return params.customValue?.trim() || "";
  if (params.mode === "recipient_phone") return params.recipient.phone || "";
  if (params.mode === "contact_name") {
    return (
      params.recipient.name?.trim() ||
      params.recipient.fields?.name?.trim() ||
      params.recipient.fields?.full_name?.trim() ||
      ""
    );
  }
  return "";
}

function applyAnalyticsAudienceVariableConfigs(params: {
  recipients: BulkAnalyticsAudienceRecipient[];
  variableConfigs?: Record<string, BulkAnalyticsVariableSourceConfig>;
}): BulkCampaignRecipient[] {
  const entries = Object.entries(params.variableConfigs || {});
  if (entries.length === 0) return params.recipients;

  return params.recipients.map(recipient => {
    const variables: Record<string, string> = {
      ...(recipient.variables || {}),
    };
    for (const [key, config] of entries) {
      const value = resolveAnalyticsAudienceVariable({
        recipient,
        mode: config.mode,
        customValue: config.customValue,
      });
      if (value) variables[key] = value;
    }

    return {
      ...recipient,
      variables: Object.keys(variables).length > 0 ? variables : undefined,
    };
  });
}

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;
type JoinedWorkspaceCompany =
  | { name?: string | null }
  | Array<{ name?: string | null }>
  | null
  | undefined;

async function resolveBulkEmailDefaultTemplateModel(params: {
  supabase: SupabaseServerClient;
  workspaceId: string;
  requestUrl: string;
}): Promise<Record<string, string>> {
  const { data } = await params.supabase
    .from("workspaces")
    .select("name, companies!workspaces_company_id_fkey(name)")
    .eq("id", params.workspaceId)
    .maybeSingle();

  const workspace = data as
    | {
        name?: string | null;
        companies?: JoinedWorkspaceCompany;
      }
    | null
    | undefined;
  const company = firstOrSelf(workspace?.companies);
  const workspaceName = readStringOrEmpty(workspace?.name, { trim: true });
  const companyName = readStringOrEmpty(company?.name, { trim: true });
  const appBaseUrl = resolveBulkCampaignAppBaseUrl(params.requestUrl);

  return {
    company: companyName || workspaceName || "Your team",
    workspaceName: workspaceName || companyName || "your workspace",
    workspaceUrl: `${appBaseUrl}/panel/w/${encodeURIComponent(params.workspaceId)}`,
  };
}

function readScenarioActivationReasonCode(
  failure: ScenarioOperationFailure
): string {
  if ("code" in failure && typeof failure.code === "string") {
    return failure.code;
  }
  if ("codes" in failure && failure.codes.length > 0) {
    return failure.codes[0]!;
  }
  return failure.kind;
}

function toScenarioRevisionIso(value: unknown): string | null {
  return normalizeScenarioRevision(value)?.toISOString() ?? null;
}

/** Why a send can't turn this draft builder scenario on itself, or null. */
function readBuilderScenarioActivationRefusal(
  nodes: ScenarioGraphNodeLike[]
): { code: string; error: string } | null {
  if (hasWhatsAppQrGraphBinding(nodes)) {
    return {
      code: "whatsapp_qr_activation_requires_scenario_route",
      error:
        "Activate this Scenario before sending so its WhatsApp QR bindings can be verified.",
    };
  }
  // A trigger would also start matching inbound messages once turned on.
  if (nodes.some(node => node?.data?.kind === "trigger")) {
    return {
      code: "scenario_activation_required",
      error:
        "This scenario also has a trigger. Activate it with the switch before sending the campaign.",
    };
  }
  return null;
}

type BuilderScenarioActivation =
  | {
      ok: true;
      updatedAt: string | null;
      /** Revision the activation replaced; null when another save did it. */
      previousUpdatedAt: string | null;
    }
  | { ok: false; body: Record<string, unknown> };

/**
 * Builder scenarios stay in conversation mode, and the post-send runtime only
 * runs active ones. Turn a draft on through the validated save path before its
 * campaign is queued, or template taps and follow-ups never run. The save is
 * fenced to the revision this send checked, so it never turns on a graph the
 * trigger and QR checks did not see.
 */
async function activateBuilderScenarioForSend(actor: {
  workspaceId: string;
  scenarioId: string;
  userId: string;
  expectedUpdatedAt: string | null;
}): Promise<BuilderScenarioActivation> {
  const { workspaceId, scenarioId, userId } = actor;
  let expectedUpdatedAt = actor.expectedUpdatedAt;
  let conflictKind = "revision_conflict";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const saved = await saveScenario(
        { workspaceId, scenarioId, userId },
        {
          status: "active",
          ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
        }
      );
      logger.info("bulk_campaign.scenario_activated", {
        workspaceId,
        scenarioId,
      });
      return {
        ok: true,
        updatedAt: saved.scenario.updatedAt,
        previousUpdatedAt: expectedUpdatedAt,
      };
    } catch (error) {
      if (!(error instanceof ScenarioOperationError)) throw error;
      const failure = error.failure;
      if (
        failure.kind !== "revision_conflict" &&
        failure.kind !== "qr_activation_conflict"
      ) {
        const reasonCode = readScenarioActivationReasonCode(failure);
        logger.warn("bulk_campaign.scenario_activation_blocked", {
          workspaceId,
          scenarioId,
          reasonCode,
        });
        return {
          ok: false,
          body: {
            code: "scenario_activation_blocked",
            error:
              "This scenario can't be activated yet, so the campaign was not sent.",
            reasonCode,
            nodeIds: "nodeIds" in failure ? (failure.nodeIds ?? []) : [],
          },
        };
      }
      conflictKind = failure.kind;
      // A concurrent save won the revision. It may have activated the
      // scenario, or added an entry this send must not turn on.
      const current = await Scenario.findOne({
        _id: new Types.ObjectId(scenarioId),
        workspaceId,
        deletedAt: null,
      })
        .select("status nodes updatedAt")
        .lean<{
          status?: string;
          nodes?: ScenarioGraphNodeLike[];
          updatedAt?: unknown;
        } | null>();
      if (current?.status === "active") {
        logger.info("bulk_campaign.scenario_activated", {
          workspaceId,
          scenarioId,
        });
        return {
          ok: true,
          updatedAt: toScenarioRevisionIso(current.updatedAt),
          previousUpdatedAt: null,
        };
      }
      const refusal = readBuilderScenarioActivationRefusal(
        current?.nodes ?? []
      );
      if (refusal) return { ok: false, body: refusal };
      expectedUpdatedAt = toScenarioRevisionIso(current?.updatedAt);
    }
  }
  logger.warn("bulk_campaign.scenario_activation_blocked", {
    workspaceId,
    scenarioId,
    reasonCode: conflictKind,
  });
  return {
    ok: false,
    body: {
      code: "scenario_activation_conflict",
      error:
        "The scenario changed while it was being activated. No campaign was queued. Retry.",
      retryable: true,
    },
  };
}

/** Set once a send turned its builder scenario on. */
type BulkSendScenarioActivation = {
  fields: {
    scenarioActivated: true;
    scenarioStatus: "active";
    scenarioUpdatedAt?: string;
    previousScenarioUpdatedAt?: string;
  } | null;
};

/**
 * POST - Unified bulk send for WhatsApp, Telegram, and Email
 */
export async function POST(request: Request) {
  const scenarioActivation: BulkSendScenarioActivation = { fields: null };
  const analyticsContext: BulkSendAnalyticsContext = {};
  const response = await withScenarioActivationFields(
    await handleBulkSendRequest(request, scenarioActivation, analyticsContext),
    scenarioActivation
  );
  await captureBulkSendFunnelOutcome(analyticsContext, response);
  return response;
}

async function withScenarioActivationFields(
  response: Response,
  scenarioActivation: BulkSendScenarioActivation
): Promise<Response> {
  if (!scenarioActivation.fields) return response;
  // Admission can still refuse a send that already turned its scenario on.
  // Every later response reports it, so the editor adopts the new revision.
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return response;
  }
  return NextResponse.json(
    { ...body, ...scenarioActivation.fields },
    { status: response.status, headers: response.headers }
  );
}

async function handleBulkSendRequest(
  request: Request,
  scenarioActivation: BulkSendScenarioActivation,
  analyticsContext: BulkSendAnalyticsContext
) {
  let failureEventContext: Pick<
    BulkCampaignPolicyEvent,
    "channel" | "executionSource" | "messageKind" | "policy" | "workspaceId"
  > | null = null;
  let legacyReservationOwner: {
    workspaceId: string;
    userId: string;
    idempotencyKey: string;
    requestDigestVersion: number;
    requestDigest: string;
    reservationToken: string;
  } | null = null;
  let legacyReservationCompleted = false;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    let normalizedRequest: ReturnType<typeof parseBulkCampaignSendRequest>;
    try {
      normalizedRequest = parseBulkCampaignSendRequest(body);
    } catch (error) {
      return NextResponse.json(
        {
          error: "Invalid request body",
          details: error instanceof Error ? error.message : "Invalid request",
        },
        { status: 400 }
      );
    }

    const {
      workspaceId,
      channel,
      audience: audienceIntent,
      recipientPolicy,
      provenance: provenanceIntent,
      campaignName,
      templateName,
      languageCode,
      templateCategory,
      marketingMessagePricing,
      whatsappMessageType,
      whatsappSourceId,
      messageText,
      fromAddress,
      templateKey,
      templateModel,
      subjectOverride,
      emailContent,
      emailContentByLocale,
      messageStream,
      idempotencyKey,
      scheduledAt,
      audienceConfirmationFingerprint,
      overflowQueueConfirmed,
    } = normalizedRequest;
    const parsedRecipients =
      audienceIntent.kind === "inline"
        ? audienceIntent.recipients
        : audienceIntent.kind === "analytics_with_fill_up"
          ? audienceIntent.fillUpRecipients
          : [];
    // Public compatibility requests historically put routed template hints on
    // recipient rows. This first hint only lets Task 3 locate/verify the owned
    // Scenario graph; verified routes remain the sole template authority.
    const firstInlineTemplateHint = parsedRecipients
      .map(recipient =>
        readUntrustedRecipientCompatibilityHint(recipient, "templateName")
      )
      .find(Boolean);
    const firstInlineLanguageHint = parsedRecipients
      .map(recipient =>
        readUntrustedRecipientCompatibilityHint(recipient, "languageCode")
      )
      .find(Boolean);
    const compatibilityMessageIntentTemplateName =
      templateName?.trim() || firstInlineTemplateHint || "";
    const compatibilityMessageIntentLanguage =
      languageCode || firstInlineLanguageHint || "en";
    const analyticsAudience =
      audienceIntent.kind === "analytics_with_fill_up"
        ? { type: "bulk_analytics" as const, ...audienceIntent.analytics }
        : undefined;
    const registeredUsersAudience =
      audienceIntent.kind === "registered_users"
        ? { type: "registered_users" as const, ...audienceIntent }
        : undefined;
    const registeredBusinessPhonesAudience =
      audienceIntent.kind === "registered_business_phones"
        ? {
            type: SCENARIO_BULK_REGISTERED_BUSINESS_PHONES_AUDIENCE_SOURCE,
            ...audienceIntent,
          }
        : undefined;
    const telegramSubscribersAudience =
      audienceIntent.kind === "telegram_subscribers"
        ? {
            type: SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE,
            ...audienceIntent,
          }
        : undefined;
    const audienceUploadEvidence =
      audienceIntent.kind === "inline"
        ? audienceIntent.uploadEvidence
        : normalizedRequest.audienceUploadEvidence;
    const excludePriorFailedBulkSends =
      recipientPolicy.excludePriorFailedBulkSends;
    let recipients: BulkCampaignRecipient[] = parsedRecipients;
    const isWhatsAppServiceText =
      channel === "whatsapp" && whatsappMessageType === "service_text";
    let skippedEmailUnsubscribed = 0;
    let requestedEmailRecipientTotal: number | null = null;
    let requestedEmailUniqueRecipientTotal: number | null = null;
    const defaultEmailContent = resolveDefaultEmailContent({
      emailContent,
      emailContentByLocale,
    });
    const localizedEmailContent =
      hasLocalizedEmailContent(emailContentByLocale);
    // Verify workspace access
    const { data: membership, error: membershipError } = await supabase
      .from("company_users")
      .select("role")
      .eq("user_id", user.id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();

    if (membershipError || !membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!isWorkspaceManagerRole(membership.role)) {
      return NextResponse.json(
        { error: "Only managers and admins can send bulk messages" },
        { status: 403 }
      );
    }

    Object.assign(analyticsContext, {
      userId: user.id,
      workspaceId,
      channel,
      source: provenanceIntent.kind === "ad_hoc" ? "page" : "scenario",
      requestedRecipients: parsedRecipients.length,
      scheduled: Boolean(scheduledAt),
    } satisfies BulkSendAnalyticsContext);

    failureEventContext = {
      workspaceId,
      channel,
      messageKind:
        channel === "whatsapp"
          ? isWhatsAppServiceText
            ? "service_text"
            : "template"
          : channel,
      executionSource:
        provenanceIntent.kind === "ad_hoc" ? "ad_hoc" : "scenario_run_now",
      policy: recipientPolicy,
    };

    // Both responders commit the legacy reservation before emitting and
    // responding; a no-op send must commit, an admitted replay is best-effort.
    const respondAdmittedReplay = async (
      eventFacts: BulkCampaignEventFacts,
      responseBody: Record<string, unknown>
    ) => {
      if (legacyReservationOwner) {
        try {
          legacyReservationCompleted = await completeLegacyBulkSendOperation({
            ...legacyReservationOwner,
            responseBody,
            eventFacts,
          });
        } catch {
          legacyReservationCompleted = false;
        }
      }
      emitBulkCampaignPolicyEvent(logger, {
        ...eventFacts,
        workspaceId,
        idempotentReplay: true,
      });
      return NextResponse.json(responseBody, { status: 200 });
    };
    const respondCompletedNoOp = async (
      responseBody: Record<string, unknown>,
      eventFacts: BulkCampaignEventFacts
    ) => {
      if (legacyReservationOwner) {
        try {
          legacyReservationCompleted = await completeLegacyBulkSendOperation({
            ...legacyReservationOwner,
            responseBody,
            eventFacts,
          });
        } catch {
          legacyReservationCompleted = false;
        }
        if (!legacyReservationCompleted) {
          return bulkCampaignIdempotencyUnavailableResponse("committed");
        }
      }
      emitBulkCampaignPolicyEvent(logger, {
        ...eventFacts,
        workspaceId,
        idempotentReplay: false,
      });
      return NextResponse.json(responseBody);
    };

    const deterministicCampaignId = idempotencyKey
      ? deriveBulkSendCampaignId({
          workspaceId,
          userId: user.id,
          idempotencyKey,
        })
      : null;
    const semanticRequestDigest = {
      version: 1 as const,
      digest: createLegacyBulkSendRequestDigest(normalizedRequest),
    };
    const admittedReplayClient =
      supabaseAdmin as unknown as BulkCampaignReplayLookupClient;
    if (idempotencyKey && deterministicCampaignId) {
      let reservation;
      try {
        reservation = await reserveLegacyBulkSendOperation({
          workspaceId,
          userId: user.id,
          idempotencyKey,
          requestDigestVersion: semanticRequestDigest.version,
          requestDigest: semanticRequestDigest.digest,
        });
      } catch {
        return bulkCampaignIdempotencyUnavailableResponse("recovered");
      }
      if (reservation.status === "payload_mismatch") {
        return bulkCampaignIdempotencyPayloadMismatchResponse();
      }
      if (reservation.status === "in_progress") {
        return NextResponse.json(
          {
            code: "bulk_campaign_idempotency_in_progress",
            error: "An identical bulk campaign command is already in progress.",
            retryable: true,
            retryAfterMs: reservation.retryAfterMs,
          },
          { status: 409 }
        );
      }
      if (reservation.status === "completed") {
        let replayProjection: ReturnType<
          typeof projectBulkCampaignReplayResponse
        >;
        try {
          replayProjection = projectBulkCampaignReplayResponse(
            reservation.responseBody
          );
        } catch {
          return bulkCampaignIdempotencyUnavailableResponse("recovered");
        }
        const { result: replayResult, responseBody: cached } = replayProjection;
        const eventFacts =
          reservation.eventFacts === undefined
            ? undefined
            : parseBulkCampaignPersistedPolicyEventFacts(
                reservation.eventFacts
              );
        if (reservation.eventFacts !== undefined && !eventFacts) {
          return bulkCampaignIdempotencyUnavailableResponse("recovered");
        }
        try {
          emitBulkCampaignPolicyEvent(
            logger,
            eventFacts
              ? {
                  ...eventFacts,
                  workspaceId,
                  idempotentReplay: true,
                }
              : {
                  workspaceId,
                  factsUnavailable: "legacy_response_only",
                  itemCounts: {
                    requested: replayResult.outcome.requestedTotal,
                    accepted: replayResult.outcome.acceptedTotal,
                    queued: replayResult.outcome.queuedTotal,
                  },
                  uniqueRecipientCounts: {
                    requested: replayResult.outcome.uniqueRecipients.requested,
                    accepted: replayResult.outcome.uniqueRecipients.accepted,
                    queued: replayResult.outcome.uniqueRecipients.queued,
                  },
                  skippedByReason: replayResult.outcome.skippedByReason,
                  warnings: replayResult.outcome.warnings,
                  disposition: replayResult.outcome.disposition,
                  lifecycleStatus: replayResult.outcome.lifecycleStatus,
                  idempotentReplay: true,
                }
          );
        } catch {
          return bulkCampaignIdempotencyUnavailableResponse("recovered");
        }
        return NextResponse.json(cached, { status: 200 });
      }
      legacyReservationOwner = {
        workspaceId,
        userId: user.id,
        idempotencyKey,
        requestDigestVersion: semanticRequestDigest.version,
        requestDigest: semanticRequestDigest.digest,
        reservationToken: reservation.reservationToken,
      };

      let admittedReplay;
      try {
        admittedReplay = await lookupAdmittedBulkCampaignReplay({
          client: admittedReplayClient,
          campaignId: deterministicCampaignId,
          workspaceId,
          sentBy: user.id,
          requestDigest: semanticRequestDigest,
        });
      } catch (error) {
        if (error instanceof BulkCampaignAdmissionPayloadMismatchError) {
          return bulkCampaignIdempotencyPayloadMismatchResponse();
        }
        if (error instanceof BulkCampaignAdmissionUnavailableError) {
          return bulkCampaignIdempotencyUnavailableResponse("recovered");
        }
        throw error;
      }
      if (admittedReplay) {
        let replayProjection: ReturnType<
          typeof projectBulkCampaignReplayResponse
        >;
        try {
          replayProjection = projectBulkCampaignReplayResponse(
            admittedReplay.result
          );
        } catch {
          return bulkCampaignIdempotencyUnavailableResponse("recovered");
        }
        const { result: replayResult, responseBody: replayResponseBody } =
          replayProjection;
        try {
          const recovered = await ensureAdmittedBulkCampaignReplayStarted({
            storeClient: supabaseAdmin,
            replay: admittedReplay,
          });
          if (
            recovered.workflowStart.status === "terminal" &&
            !(
              recovered.workflowStart.dispatchStatus === "completed" &&
              replayResult.outcome.disposition === "no_op" &&
              replayResult.outcome.lifecycleStatus === "completed"
            )
          ) {
            const terminalError = createPreparedBulkCampaignTerminalReplayError(
              {
                campaignId: admittedReplay.campaignId,
                dispatchStatus: recovered.workflowStart.dispatchStatus,
              }
            );
            emitBulkCampaignPolicyEvent(
              logger,
              createBulkCampaignTerminalReplayPolicyEvent({
                replay: admittedReplay,
                outcome: replayResult.outcome,
                dispatchStatus: recovered.workflowStart.dispatchStatus,
              })
            );
            return NextResponse.json(terminalError.body, {
              status: terminalError.httpStatus,
            });
          }
        } catch (error) {
          if (error instanceof PreparedBulkCampaignQueueError) {
            return NextResponse.json(error.body, { status: error.httpStatus });
          }
          throw error;
        }
        const replayEventFacts =
          createBulkCampaignAdmittedReplayPolicyEventFacts({
            replay: admittedReplay,
            outcome: replayResult.outcome,
          });
        return await respondAdmittedReplay(
          replayEventFacts,
          replayResponseBody
        );
      }
    }

    const schedule = normalizeBulkSendScheduledAt(scheduledAt);
    if (!schedule.ok) {
      return NextResponse.json({ error: schedule.error }, { status: 400 });
    }
    const campaignId = deterministicCampaignId || randomUUID();

    let whatsappSendContext: Awaited<
      ReturnType<typeof resolveWhatsAppSendContext>
    > | null = null;
    let provenanceCapability: VerifiedBulkCampaignProvenanceCapability | null =
      null;
    if (channel === "whatsapp" && !isWhatsAppServiceText) {
      whatsappSendContext = await resolveWhatsAppSendContext({
        workspaceId,
        sourceId: whatsappSourceId,
      });
      if (
        !whatsappSendContext?.sourceId ||
        !whatsappSendContext.phoneNumberId ||
        !whatsappSendContext.accessToken ||
        !compatibilityMessageIntentTemplateName
      ) {
        return NextResponse.json(
          {
            code: "whatsapp_message_intent_unavailable",
            error: "WhatsApp template send context is incomplete.",
          },
          { status: 400 }
        );
      }
      try {
        provenanceCapability = await verifyBulkCampaignProvenanceCapability({
          workspaceId,
          intent: provenanceIntent,
          channel: "whatsapp",
          messageIntent: {
            kind: "whatsapp_template",
            sourceId: whatsappSendContext.sourceId,
            templateName: compatibilityMessageIntentTemplateName,
            language: compatibilityMessageIntentLanguage,
          },
        });
      } catch (error) {
        logger.warn("bulk_campaign.provenance_invalid", {
          workspaceId,
          provenanceKind: provenanceIntent.kind,
          scenarioId:
            provenanceIntent.kind === "ad_hoc"
              ? null
              : provenanceIntent.scenarioId,
          reason:
            error instanceof BulkCampaignProvenanceError
              ? error.reason
              : "unexpected_error",
          cause:
            error instanceof Error && error.cause instanceof Error
              ? error.cause.message
              : undefined,
        });
        // A template lookup that clears by itself (Meta throttling the
        // account, an unavailable catalog, a Graph 500) is answered like the
        // ad-hoc template check. Any other lookup failure, such as lost
        // WhatsApp access or a failed scenario read, keeps its 403.
        if (
          error instanceof BulkCampaignProvenanceError &&
          error.reason === "lookup_failed" &&
          isTransientBulkCampaignTemplateLookupFailure(error.cause)
        ) {
          throw bulkCampaignTemplateLookupError(error.cause);
        }
        return NextResponse.json(
          {
            code: "bulk_campaign_provenance_invalid",
            error:
              error instanceof BulkCampaignProvenanceError &&
              error.reason === "template_bindings_require_conversation"
                ? error.message
                : "Bulk campaign provenance could not be verified.",
          },
          { status: 403 }
        );
      }
    }
    if (
      isWhatsAppServiceText &&
      !(await isWorkspaceFeatureEnabled(workspaceId, "whatsapp_service_bulk"))
    ) {
      return NextResponse.json(
        {
          code: "whatsapp_service_bulk_not_enabled",
          error: "WhatsApp service bulk messages are not enabled.",
        },
        { status: 403 }
      );
    }

    let providerConfig:
      | Extract<EmailBulkSendContext, { ok: true }>["providerConfig"]
      | null = null;
    let emailTemplateModelDefaults: Record<string, string> = {};

    // Get channel credentials
    let telegramSource: { data?: unknown } | null = null;
    if (channel === "telegram") {
      let telegramSourceQuery = supabase
        .from("sources")
        .select("id, credentials")
        .eq("workspace_id", workspaceId)
        .eq("type", channel);
      if (telegramSubscribersAudience?.sourceId) {
        telegramSourceQuery = telegramSourceQuery.eq(
          "id",
          telegramSubscribersAudience.sourceId
        );
      }
      telegramSource = await telegramSourceQuery
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
    }
    const telegramSourceData = telegramSource?.data as
      | {
          id?: string | null;
          credentials?: { bot_token?: unknown } | null;
        }
      | null
      | undefined;

    if (
      channel === "telegram" &&
      (!telegramSourceData?.id ||
        !hasStoredTelegramBotToken(telegramSourceData.credentials))
    ) {
      return NextResponse.json(
        {
          error: `${channel.charAt(0).toUpperCase() + channel.slice(1)} credentials not found`,
        },
        { status: 404 }
      );
    }

    if (channel === "whatsapp" && !whatsappSendContext) {
      whatsappSendContext = await resolveWhatsAppSendContext({
        workspaceId,
        sourceId: whatsappSourceId,
      });
    }

    if (channel === "whatsapp" && !whatsappSendContext) {
      return NextResponse.json(
        { error: "WhatsApp credentials incomplete" },
        { status: 500 }
      );
    }

    const campaignPlanPreview = await resolveCampaignBatchPlanPreview({
      channel,
      wabaId: whatsappSendContext?.wabaId,
      phoneNumberId: whatsappSendContext?.phoneNumberId,
      accessToken: whatsappSendContext?.accessToken,
      cachedMessagingLimit: whatsappSendContext?.cachedMessagingLimit,
    });

    if (
      channel === "whatsapp" &&
      !isWhatsAppServiceText &&
      campaignPlanPreview.readiness?.state !== "ready"
    ) {
      const readiness = campaignPlanPreview.readiness;
      return NextResponse.json(
        {
          code:
            readiness?.state === "blocked"
              ? "whatsapp_sending_blocked"
              : "whatsapp_sending_unavailable",
          error:
            readiness?.state === "blocked"
              ? "WhatsApp business sending is currently blocked."
              : "WhatsApp sending readiness could not be verified. Check again before sending.",
          readiness,
        },
        {
          status: readiness?.state === "blocked" ? 409 : 503,
          headers: { "Cache-Control": "private, no-store" },
        }
      );
    }

    if (
      channel === "whatsapp" &&
      (!campaignPlanPreview.recipientLimit.maxRecipients ||
        campaignPlanPreview.recipientLimit.maxRecipients <= 0)
    ) {
      return NextResponse.json(
        {
          error:
            campaignPlanPreview.recipientLimit.error ||
            "WhatsApp recipient limit is unavailable.",
          recipientLimit: campaignPlanPreview.recipientLimit,
        },
        { status: 400 }
      );
    }

    if (channel === "email") {
      const emailContext = await resolveEmailBulkSendContext({ workspaceId });
      if (!emailContext.ok) {
        if (emailContext.code === "email_provider_verification_pending") {
          return NextResponse.json(
            {
              error: emailContext.error,
              code: emailContext.code,
            },
            { status: 400 }
          );
        }
        return NextResponse.json(
          {
            error: emailContext.error,
          },
          { status: 400 }
        );
      }
      providerConfig = emailContext.providerConfig;
      const effectiveFromAddress = emailContext.fromAddress;
      if (fromAddress !== undefined && fromAddress !== null) {
        const normalizedLegacy = normalizeCampaignEmail(fromAddress);
        if (normalizedLegacy && normalizedLegacy !== effectiveFromAddress) {
          return NextResponse.json(
            {
              error:
                "fromAddress must match the workspace default sender. Use the default sender configured in Settings > Integrations > Email, or omit fromAddress.",
              expectedFromAddress: effectiveFromAddress,
            },
            { status: 400 }
          );
        }
      }
      emailTemplateModelDefaults = await resolveBulkEmailDefaultTemplateModel({
        supabase,
        workspaceId,
        requestUrl: request.url,
      });

      if (registeredUsersAudience) {
        const canUseRegisteredUsersAudience =
          await isRegisteredUsersEmailAudienceEnabledForWorkspace({
            workspaceId,
          });
        if (!canUseRegisteredUsersAudience) {
          return NextResponse.json(
            {
              error:
                "Registered app users audience requires platform admin access in the airi.chat workspace.",
            },
            { status: 403 }
          );
        }

        const audience = await resolveRegisteredUsersEmailAudience({
          workspaceId,
          supabase,
        });
        if (registeredUsersAudience.selectedUserIds) {
          const selectedUserIds = new Set(
            registeredUsersAudience.selectedUserIds
              .map(id => id.trim())
              .filter(Boolean)
          );
          recipients = audience.recipients.filter(recipient => {
            const userId =
              recipient.variables?.userId || recipient.fields?.user_id || "";
            return selectedUserIds.has(userId);
          });
        } else {
          recipients = audience.recipients;
        }
        if (recipients.length === 0) {
          return NextResponse.json(
            {
              error:
                "No registered app users with valid email addresses were found.",
              eligibleRecipientCount: audience.recipients.length,
              selectedRecipientCount: 0,
            },
            { status: 400 }
          );
        }
      }

      const invalidRecipientCount = recipients.filter(
        recipient => !isValidCampaignEmailAddress(recipient.email || "")
      ).length;
      if (invalidRecipientCount > 0) {
        return NextResponse.json(
          {
            error: "Some recipient emails are invalid. Fix the list and retry.",
            invalidRecipientCount,
          },
          { status: 400 }
        );
      }

      requestedEmailRecipientTotal = recipients.length;
      requestedEmailUniqueRecipientTotal = new Set(
        recipients.flatMap(recipient => {
          const identity = canonicalizeBulkCampaignRecipientIdentity({
            channel: "email",
            recipient,
          });
          return identity ? [identity] : [];
        })
      ).size;
      const unsubscribedFilter = await filterEmailUnsubscribedRecipients({
        supabase: supabaseAdmin,
        workspaceId,
        recipients,
      });
      recipients = unsubscribedFilter.recipients;
      skippedEmailUnsubscribed = unsubscribedFilter.skippedUnsubscribed;
    }

    const effectiveFromAddress =
      channel === "email" && providerConfig
        ? providerConfig.defaultFromAddress
        : "";
    const appBaseUrl = resolveBulkCampaignAppBaseUrl(request.url);

    let requestedTotal = recipients.length;
    let requestedChannelUniqueRecipientTotal =
      requestedEmailUniqueRecipientTotal ??
      new Set(
        recipients.flatMap(recipient => {
          const identity = canonicalizeBulkCampaignRecipientIdentity({
            channel,
            recipient,
          });
          return identity ? [identity] : [];
        })
      ).size;
    let recipientsToSend = recipients;
    let whatsappAudienceComplete = true;
    let eligibilityResolution: BulkCampaignEligibilityResolution<BulkCampaignRecipient> | null =
      null;
    const verifiedRouteByRecipient = new Map<
      BulkCampaignRecipient,
      NonNullable<
        BulkCampaignEligibilityResolution<BulkCampaignRecipient>["verifiedProvenance"]["routes"][number]
      >
    >();
    let skippedServiceWindow = 0;
    let skippedRecentContact = 0;
    let contactEvaluatedAt: Date | null = null;
    let skippedRecipientLimit = 0;
    let serviceWindowExpiresAtByPhone: Record<string, string> = {};
    let recipientLimitMeta: {
      originalCount: number;
      acceptedCount: number;
      rawLimit?: string | null;
      source?: string;
      truncated: boolean;
    } | null = null;
    let resolvedTemplateCategory:
      | "MARKETING"
      | "UTILITY"
      | "AUTHENTICATION"
      | undefined;
    let approvedTemplateCatalog: WhatsAppTemplate[] | undefined;
    let approvedTemplateCatalogMetadata:
      | WhatsAppTemplateCatalogMetadata
      | undefined;
    let skippedOptIn = 0;
    let skippedPriorFailed = 0;
    const approvedTemplateByRecipient = new Map<
      BulkCampaignRecipient,
      NonNullable<
        BulkCampaignEligibilityResolution<BulkCampaignRecipient>["retained"][number]["approvedTemplate"]
      >
    >();

    if (isWhatsAppServiceText) {
      requestedChannelUniqueRecipientTotal = new Set(
        recipientsToSend.flatMap(recipient => {
          const identity = canonicalizeBulkCampaignRecipientIdentity({
            channel: "whatsapp",
            recipient,
          });
          return identity ? [identity] : [];
        })
      ).size;
      const serviceEligibility = await resolveWhatsAppServiceWindowEligibility({
        workspaceId,
        sourceId: whatsappSendContext?.sourceId || "",
        phones: recipientsToSend
          .map(recipient => recipient.phone || "")
          .filter(Boolean),
      });
      const eligiblePhones = new Set(serviceEligibility.eligiblePhones);
      serviceWindowExpiresAtByPhone = serviceEligibility.windowExpiresAtByPhone;
      requestedTotal = recipientsToSend.length;
      recipientsToSend = recipientsToSend.filter(recipient => {
        const phone = normalizeCampaignPhone(recipient.phone || "");
        return Boolean(phone && eligiblePhones.has(phone));
      });
      recipients = recipientsToSend;
      skippedServiceWindow = requestedTotal - recipientsToSend.length;

      // Service text has no eligibility preview, so the workspace contact
      // policy leaves out recently contacted recipients here, as the
      // template policy does.
      contactEvaluatedAt = new Date();
      let contacts: Awaited<
        ReturnType<
          typeof partitionRecentlyContactedRecipients<{
            phone: string;
            recipient: BulkCampaignRecipient;
          }>
        >
      >;
      try {
        contacts = await partitionRecentlyContactedRecipients({
          workspaceId,
          recipients: recipientsToSend.map(recipient => ({
            phone: recipient.phone || "",
            recipient,
          })),
          now: contactEvaluatedAt,
        });
      } catch (cause) {
        throw new BulkCampaignEligibilityError("contact_policy_unavailable", {
          cause,
        });
      }
      recipientsToSend = contacts.allowed.map(entry => entry.recipient);
      recipients = recipientsToSend;
      skippedRecentContact = contacts.recentlyContacted.length;
    }

    if (registeredBusinessPhonesAudience) {
      const canUseRegisteredBusinessPhonesAudience =
        await isRegisteredUsersEmailAudienceEnabledForWorkspace({
          workspaceId,
        });
      if (!canUseRegisteredBusinessPhonesAudience) {
        return NextResponse.json(
          {
            error:
              "Registered business phone audience requires platform admin access in the airi.chat workspace.",
          },
          { status: 403 }
        );
      }

      const audience = await resolveRegisteredBusinessPhoneAudience({
        workspaceId,
        selectedPhones: registeredBusinessPhonesAudience.selectedPhones,
        limit: MAX_BULK_CAMPAIGN_RECIPIENTS,
      });
      whatsappAudienceComplete = audience.complete;
      recipients = audience.recipients;
      requestedTotal = audience.total;
      recipientsToSend = recipients;

      if (recipients.length === 0) {
        return NextResponse.json(
          {
            error:
              "No registered business phone contacts were found for this workspace.",
            audience,
          },
          { status: 400 }
        );
      }
    }

    if (telegramSubscribersAudience) {
      if (channel !== "telegram") {
        return NextResponse.json(
          {
            error:
              "telegramSubscribersAudience is only supported for Telegram campaigns",
          },
          { status: 400 }
        );
      }
      if (
        !telegramSourceData?.id ||
        telegramSourceData.id !== telegramSubscribersAudience.sourceId
      ) {
        return NextResponse.json(
          {
            error:
              "Telegram subscriber audience source must match a connected Telegram source in this workspace.",
          },
          { status: 400 }
        );
      }

      const audience = await resolveTelegramSubscribersAudience({
        workspaceId,
        sourceId: telegramSubscribersAudience.sourceId,
        selectedChatIds: telegramSubscribersAudience.selectedChatIds,
      });
      recipients = audience.recipients;
      requestedTotal = audience.total;
      recipientsToSend = recipients;

      if (recipients.length === 0) {
        return NextResponse.json(
          {
            error:
              "No eligible Telegram subscribers were found for this source.",
            audience,
          },
          { status: 400 }
        );
      }
    }

    if (analyticsAudience) {
      if (channel !== "whatsapp") {
        return NextResponse.json(
          {
            error: "analyticsAudience is only supported for WhatsApp campaigns",
          },
          { status: 400 }
        );
      }

      if (
        provenanceIntent.kind === "ad_hoc" &&
        whatsappSendContext?.sourceId &&
        templateName
      ) {
        try {
          const catalogResult = await readApprovedWhatsAppTemplatesForSend(
            workspaceId,
            {
              sourceId: whatsappSendContext.sourceId,
            }
          );
          approvedTemplateCatalog = catalogResult.templates;
          approvedTemplateCatalogMetadata = catalogResult.catalog;
        } catch (error) {
          throw bulkCampaignTemplateLookupError(error);
        }
        const observedTemplate = await resolveApprovedWhatsAppTemplateForSend({
          workspaceId,
          sourceId: whatsappSendContext.sourceId,
          templateName,
          languageCode: languageCode || "en",
          templates: approvedTemplateCatalog,
          allowLiveFetch: false,
        });
        resolvedTemplateCategory = observedTemplate.template?.category;
      }

      let audience: Awaited<ReturnType<typeof resolveBulkAnalyticsAudience>>;
      try {
        audience = await resolveBulkAnalyticsAudience({
          workspaceId,
          filters: analyticsAudience.filters,
          templateCategory: resolvedTemplateCategory || null,
        });
      } catch (error) {
        if (error instanceof BulkAnalyticsAudienceUnavailableError) {
          return NextResponse.json(
            { error: error.message, code: error.code },
            { status: 409 }
          );
        }
        throw error;
      }

      if (audience.capped) {
        return NextResponse.json(
          {
            error: `Analytics audience is larger than ${audience.maxRecipients} recipients. Narrow the filter before sending.`,
          },
          { status: 413 }
        );
      }

      const analyticsRecipients = applyAnalyticsAudienceVariableConfigs({
        // The resolver's `optedIn` field is advisory for older campaign-history
        // rows. The final marketing audience is verified against the shared
        // positive-consent store below, including analytics recipients.
        recipients: audience.recipients,
        variableConfigs: analyticsAudience.variableConfigs,
      });
      const mergedRecipients = mergeCampaignRecipientsWithFillUp({
        channel,
        baseRecipients: analyticsRecipients,
        fillUpRecipients: parsedRecipients,
      });
      recipients = mergedRecipients.recipients;
      requestedTotal = audience.total + parsedRecipients.length;
      recipientsToSend = recipients;

      if (recipients.length === 0) {
        return NextResponse.json(
          { error: "No recipients match the analytics filter." },
          { status: 400 }
        );
      }
    }

    // Free plans keep the first recipients that fit their bulk allowance,
    // the same way every send keeps the first ones within the Meta limit.
    const bulkRecipientAllowance = await readCompanyBulkRecipientAllowance(
      supabaseAdmin,
      workspaceId
    );
    if (bulkRecipientAllowance.remaining === 0) {
      return buildCompanyBulkRecipientLimitExceededResponse(
        bulkRecipientAllowance.limit
      );
    }

    if (channel === "whatsapp" && !isWhatsAppServiceText) {
      if (!provenanceCapability || !whatsappSendContext?.sourceId) {
        return NextResponse.json(
          {
            code: "bulk_campaign_provenance_invalid",
            error: "Bulk campaign provenance could not be verified.",
          },
          { status: 403 }
        );
      }
      const fingerprintSecret = process.env.ENCRYPTION_SECRET;
      if (!fingerprintSecret?.trim()) {
        return NextResponse.json(
          {
            code: "bulk_campaign_safety_unavailable",
            error: "Bulk campaign safety is not configured.",
          },
          { status: 503 }
        );
      }
      const resolvedCandidates = recipientsToSend.map((recipient, index) => ({
        stableId: `send:${index}`,
        recipient,
        value: recipient,
      }));
      eligibilityResolution = await resolveBulkCampaignRecipientEligibility(
        {
          workspaceId,
          channel: "whatsapp",
          messageIntent: {
            kind: "whatsapp_template",
            sourceId: whatsappSendContext.sourceId,
            templateName: compatibilityMessageIntentTemplateName,
            language: compatibilityMessageIntentLanguage,
          },
          audience: audienceIntent,
          recipientPolicy,
          provenanceCapability,
          ...(approvedTemplateCatalog
            ? { approvedTemplateCatalog, approvedTemplateCatalogMetadata }
            : {}),
          ...(templateCategory
            ? { compatibilityTemplateCategoryHint: templateCategory }
            : {}),
          campaignId,
          recipientAllowance: bulkRecipientAllowance.remaining,
        },
        {
          resolveAudience: async () => ({
            candidates: resolvedCandidates,
            completeness: {
              complete: whatsappAudienceComplete,
              uniqueRecipients: new Set(
                recipientsToSend.map(recipient =>
                  canonicalizeBulkCampaignRecipientIdentity({
                    channel: "whatsapp",
                    recipient,
                  })
                )
              ).size,
              dispatchItems: recipientsToSend.length,
              uniqueRecipientHardCap: MAX_BULK_CAMPAIGN_RECIPIENTS,
              dispatchItemHardCap: MAX_BULK_CAMPAIGN_RECIPIENTS,
            },
          }),
          preflight: preflightBulkCampaignWhatsAppTemplate,
          resolvePlan: ({ sourceId }) =>
            sourceId === whatsappSendContext.sourceId
              ? Promise.resolve(campaignPlanPreview)
              : resolveBulkCampaignWhatsAppPlan({ workspaceId, sourceId }),
          ...(recipientPolicy.excludePriorFailedBulkSends
            ? {
                priorFailure: {
                  client: supabaseAdmin,
                  secret: fingerprintSecret,
                },
              }
            : {}),
        }
      );
      recipientsToSend = eligibilityResolution.retained.map(
        candidate => candidate.value
      );
      recipients = recipientsToSend;
      requestedTotal = eligibilityResolution.preview.requestedTotal;
      skippedOptIn =
        eligibilityResolution.preview.skippedByReason.marketing_opt_out || 0;
      skippedPriorFailed =
        eligibilityResolution.preview.skippedByReason.prior_failure || 0;
      recipientLimitMeta = {
        originalCount:
          eligibilityResolution.preview.acceptedTotal +
          (eligibilityResolution.preview.skippedByReason.prior_failure || 0) +
          (eligibilityResolution.preview.skippedByReason.recipient_limit || 0),
        acceptedCount: recipientsToSend.length,
        rawLimit: eligibilityResolution.plan.recipientLimit.rawLimit,
        source: eligibilityResolution.plan.recipientLimit.source,
        truncated:
          (eligibilityResolution.preview.skippedByReason.recipient_limit || 0) >
          0,
      };
      const routeByStableId = new Map(
        eligibilityResolution.verifiedProvenance.routes.map(route => [
          route.recipientStableId,
          route,
        ])
      );
      for (const candidate of eligibilityResolution.retained) {
        const route = routeByStableId.get(candidate.stableId);
        if (route) verifiedRouteByRecipient.set(candidate.value, route);
        if (candidate.approvedTemplate) {
          approvedTemplateByRecipient.set(
            candidate.value,
            candidate.approvedTemplate
          );
        }
      }
      const approvedTemplateCategories = new Set(
        eligibilityResolution.approvedTemplateCategories
      );
      if (approvedTemplateCategories.size === 1) {
        resolvedTemplateCategory = Array.from(approvedTemplateCategories)[0];
      }
      if (
        registeredBusinessPhonesAudience &&
        resolvedTemplateCategory !== "MARKETING"
      ) {
        return NextResponse.json(
          {
            error:
              "Registered business phone follow-ups require a MARKETING WhatsApp template.",
          },
          { status: 400 }
        );
      }
      if (
        marketingMessagePricing?.perMessageBidMultiplier !== undefined &&
        (resolvedTemplateCategory !== "MARKETING" ||
          whatsappSendContext.marketingMessagesEnabled !== true)
      ) {
        return NextResponse.json(
          {
            error:
              "marketingMessagePricing requires a MARKETING template and an onboarded WhatsApp Marketing Messages API source.",
          },
          { status: 400 }
        );
      }

      if (eligibilityResolution.preview.allExcluded) {
        const result = createBulkCampaignSuccessResult({
          disposition: "no_op",
          evaluatedAt: eligibilityResolution.preview.evaluatedAt,
          lifecycleStatus: "completed",
          requestedTotal,
          acceptedTotal: 0,
          queuedTotal: 0,
          uniqueRecipients: {
            requested: eligibilityResolution.preview.uniqueRecipients.requested,
            accepted: 0,
            queued: 0,
          },
          skippedByReason: eligibilityResolution.preview.skippedByReason,
          warnings: eligibilityResolution.preview.warnings,
        });
        const responseBody: Record<string, unknown> =
          serializeBulkCampaignCommandResult(result);
        const eventFacts: Omit<
          BulkCampaignPolicyEvent,
          "workspaceId" | "idempotentReplay"
        > = {
          channel: "whatsapp",
          messageKind: "template",
          executionSource:
            eligibilityResolution.verifiedProvenance.kind === "scenario_run_now"
              ? "scenario_run_now"
              : "ad_hoc",
          scenarioId: eligibilityResolution.verifiedProvenance.scenarioId,
          rootNodeId: eligibilityResolution.verifiedProvenance.rootNodeId,
          itemCounts: { requested: requestedTotal, accepted: 0, queued: 0 },
          uniqueRecipientCounts: {
            requested: eligibilityResolution.preview.uniqueRecipients.requested,
            accepted: 0,
            queued: 0,
          },
          skippedByReason: eligibilityResolution.preview.skippedByReason,
          warnings: eligibilityResolution.preview.warnings,
          disposition: "no_op",
          lifecycleStatus: "completed",
          planLimit: {
            source: eligibilityResolution.plan.recipientLimit.source,
            value: eligibilityResolution.plan.recipientLimit.maxRecipients,
          },
          policy: recipientPolicy,
        };
        return await respondCompletedNoOp(responseBody, eventFacts);
      }
    }

    if (channel === "telegram") {
      recipients = recipients.map(recipient => ({
        ...recipient,
        chatId: normalizeTelegramChatId(recipient.chatId),
        sourceId:
          (typeof recipient.sourceId === "string" && recipient.sourceId.trim()
            ? recipient.sourceId.trim()
            : telegramSourceData?.id) || "",
      }));
      requestedChannelUniqueRecipientTotal = new Set(
        recipients.flatMap(recipient => {
          const identity = canonicalizeBulkCampaignRecipientIdentity({
            channel: "telegram",
            recipient,
          });
          return identity ? [identity] : [];
        })
      ).size;
      const telegramEligibility = await resolveEligibleTelegramBulkRecipients({
        workspaceId,
        recipients,
        defaultSourceId: telegramSourceData?.id || "",
      });
      recipients = telegramEligibility.recipients;
      recipientsToSend = telegramEligibility.recipients;
    }

    if (!eligibilityResolution) {
      const maxRecipients = campaignPlanPreview.recipientLimit.maxRecipients;
      if (
        campaignPlanPreview.recipientLimit.source === "unavailable" ||
        !Number.isInteger(maxRecipients) ||
        !maxRecipients ||
        maxRecipients <= 0
      ) {
        throw new BulkCampaignEligibilityError("plan_unavailable");
      }
      const originalCount = recipientsToSend.length;
      const limited = retainBulkCampaignRecipientsWithinUniqueLimit({
        channel,
        recipients: recipientsToSend,
        maxUniqueRecipients: Math.min(
          MAX_BULK_CAMPAIGN_RECIPIENTS,
          bulkRecipientAllowance.remaining ?? MAX_BULK_CAMPAIGN_RECIPIENTS
        ),
      });
      recipientsToSend = limited.recipients;
      recipients = limited.recipients;
      skippedRecipientLimit = limited.skipped;
      recipientLimitMeta = {
        originalCount,
        acceptedCount: recipientsToSend.length,
        rawLimit: campaignPlanPreview.recipientLimit.rawLimit,
        source: campaignPlanPreview.recipientLimit.source,
        truncated: limited.skipped > 0,
      };
    }

    const verifiedProvenance = eligibilityResolution?.verifiedProvenance;
    const normalizedScenarioId =
      verifiedProvenance?.scenarioId ||
      (channel !== "whatsapp" &&
      (provenanceIntent.kind === "scenario_run_now" ||
        provenanceIntent.kind === "legacy_scenario_run_now")
        ? provenanceIntent.scenarioId
        : null);
    const normalizedScenarioNodeId =
      verifiedProvenance?.rootNodeId ||
      (channel !== "whatsapp"
        ? provenanceIntent.kind === "scenario_run_now"
          ? provenanceIntent.rootNodeId
          : provenanceIntent.kind === "legacy_scenario_run_now"
            ? provenanceIntent.claimedNodeId
            : null
        : null);
    const normalizedExecutionSource = (
      verifiedProvenance?.kind === "scenario_run_now" ||
      (!verifiedProvenance &&
        channel !== "whatsapp" &&
        provenanceIntent.kind !== "ad_hoc")
        ? "scenario_run_now"
        : "ad_hoc"
    ) as BulkCampaignDispatchExecutionSource;

    if (!eligibilityResolution && recipientsToSend.length === 0) {
      const requestedOutcomeTotal =
        channel === "email"
          ? (requestedEmailRecipientTotal ?? requestedTotal)
          : requestedTotal;
      const knownSkipped =
        skippedServiceWindow +
        skippedEmailUnsubscribed +
        skippedRecipientLimit +
        skippedRecentContact;
      const skippedIneligible = Math.max(
        0,
        requestedOutcomeTotal - knownSkipped
      );
      const outcome = accumulateBulkCampaignEligibilityOutcome({
        requestedTotal: requestedOutcomeTotal,
        acceptedTotal: 0,
        uniqueRecipients: {
          requested: requestedChannelUniqueRecipientTotal,
          accepted: 0,
        },
        stages: [
          {
            skippedByReason: {
              ...(skippedIneligible > 0
                ? { ineligible: skippedIneligible }
                : {}),
              ...(skippedServiceWindow > 0
                ? { service_window: skippedServiceWindow }
                : {}),
              ...(skippedEmailUnsubscribed > 0
                ? { unsubscribed: skippedEmailUnsubscribed }
                : {}),
              ...(skippedRecipientLimit > 0
                ? { recipient_limit: skippedRecipientLimit }
                : {}),
              ...(skippedRecentContact > 0
                ? { recent_contact: skippedRecentContact }
                : {}),
            },
            warnings: { missingMarketingConsent: 0 },
          },
        ],
      });
      const result = createBulkCampaignSuccessResult({
        disposition: "no_op",
        // The outcome is as of the contact policy check, not the response.
        evaluatedAt: (contactEvaluatedAt || new Date()).toISOString(),
        lifecycleStatus: "completed",
        requestedTotal: outcome.requestedTotal,
        acceptedTotal: 0,
        queuedTotal: 0,
        uniqueRecipients: {
          requested: outcome.uniqueRecipients.requested,
          accepted: 0,
          queued: 0,
        },
        skippedByReason: outcome.skippedByReason,
        warnings: outcome.warnings,
      });
      const responseBody: Record<string, unknown> = {
        ...serializeBulkCampaignCommandResult(result),
        recipientLimit: recipientLimitMeta,
        ...(channel === "whatsapp" && isWhatsAppServiceText
          ? { requestedTotal, skippedServiceWindow }
          : {}),
        ...(channel === "email"
          ? {
              requestedTotal: requestedEmailRecipientTotal ?? requestedTotal,
              skippedUnsubscribed: skippedEmailUnsubscribed,
            }
          : {}),
      };
      const eventFacts: Omit<
        BulkCampaignPolicyEvent,
        "workspaceId" | "idempotentReplay"
      > = {
        channel,
        messageKind: channel === "whatsapp" ? "service_text" : channel,
        executionSource: normalizedExecutionSource,
        scenarioId: normalizedScenarioId,
        rootNodeId: normalizedScenarioNodeId,
        itemCounts: {
          requested: outcome.requestedTotal,
          accepted: 0,
          queued: 0,
        },
        uniqueRecipientCounts: {
          requested: outcome.uniqueRecipients.requested,
          accepted: 0,
          queued: 0,
        },
        skippedByReason: outcome.skippedByReason,
        warnings: outcome.warnings,
        disposition: "no_op",
        lifecycleStatus: "completed",
        planLimit: {
          source: campaignPlanPreview.recipientLimit.source,
          value: campaignPlanPreview.recipientLimit.maxRecipients,
        },
        policy: recipientPolicy,
      };
      return await respondCompletedNoOp(responseBody, eventFacts);
    }

    const capacity = await ensureCompanyConversationCapacity(
      supabaseAdmin,
      workspaceId
    );
    if (!capacity.allowed) {
      return buildCompanyLimitExceededResponse(capacity.limit);
    }

    let isLegacyBulkCampaignScenario = false;
    // The revision the builder checks below ran on; activation is fenced to it.
    let builderScenarioActivationTarget: {
      expectedUpdatedAt: string | null;
    } | null = null;
    if (
      normalizedScenarioId &&
      Types.ObjectId.isValid(normalizedScenarioId) &&
      normalizedExecutionSource === "scenario_run_now"
    ) {
      await connectDB();
      const scenarioActivationProjection = await Scenario.findOne({
        _id: new Types.ObjectId(normalizedScenarioId),
        workspaceId,
        deletedAt: null,
      })
        .select("status mode nodes updatedAt")
        .lean<{
          status?: string;
          mode?: string;
          nodes?: ScenarioGraphNodeLike[];
          updatedAt?: unknown;
        } | null>();
      const scenarioNodes = scenarioActivationProjection?.nodes ?? [];
      isLegacyBulkCampaignScenario =
        scenarioActivationProjection?.mode === "bulk_campaign";
      if (
        isLegacyBulkCampaignScenario &&
        scenarioActivationProjection?.status === "draft" &&
        hasWhatsAppQrGraphBinding(scenarioNodes)
      ) {
        return NextResponse.json(
          {
            code: "whatsapp_qr_activation_requires_scenario_route",
            error:
              "Activate this Scenario before sending so its WhatsApp QR bindings can be verified.",
          },
          { status: 409 }
        );
      }
      // Builder scenarios stay in conversation mode. A WhatsApp template send
      // locks each conversation to the scenario, so a draft must be turned on
      // before queueing. Only a graph whose bulk root is its only entry is
      // turned on here.
      if (
        scenarioActivationProjection &&
        !isLegacyBulkCampaignScenario &&
        verifiedProvenance?.kind === "scenario_run_now" &&
        scenarioActivationProjection.status !== "active"
      ) {
        const refusal = readBuilderScenarioActivationRefusal(scenarioNodes);
        if (refusal) {
          return NextResponse.json(refusal, { status: 409 });
        }
        builderScenarioActivationTarget = {
          expectedUpdatedAt: toScenarioRevisionIso(
            scenarioActivationProjection.updatedAt
          ),
        };
      }
    }

    if (!isTemporalConfigured()) {
      return NextResponse.json(
        {
          error:
            "Bulk campaign dispatch requires Temporal, but it is not configured.",
        },
        { status: 503 }
      );
    }

    const fingerprintSecret = process.env.ENCRYPTION_SECRET;
    if (!fingerprintSecret?.trim()) {
      return NextResponse.json(
        {
          code: "bulk_campaign_safety_unavailable",
          error: "Bulk campaign safety is not configured.",
        },
        { status: 503 }
      );
    }

    const hasVerifiedColumnSplit = Boolean(
      eligibilityResolution?.verifiedProvenance.columnSplitNodeId
    );
    const campaignHistoryInput = CampaignHistoryCreateInputSchema.safeParse({
      workspaceId,
      name:
        campaignName?.trim() ||
        `${channel.charAt(0).toUpperCase()}${channel.slice(1)} bulk campaign`,
      channel,
      templateName:
        channel === "email"
          ? templateKey || (defaultEmailContent ? "custom_email" : null)
          : channel === "whatsapp" && hasVerifiedColumnSplit
            ? null
            : eligibilityResolution?.retained[0]?.approvedTemplate?.name ||
              eligibilityResolution?.verifiedProvenance.routes[0]?.template
                ?.name ||
              templateName ||
              null,
      templateLanguage:
        channel === "whatsapp"
          ? hasVerifiedColumnSplit
            ? "multi"
            : eligibilityResolution?.retained[0]?.approvedTemplate?.language ||
              eligibilityResolution?.verifiedProvenance.routes[0]?.template
                ?.language ||
              languageCode ||
              ""
          : localizedEmailContent
            ? "multi"
            : DEFAULT_EMAIL_CAMPAIGN_LOCALE,
      messageText: isWhatsAppServiceText
        ? messageText || null
        : channel === "telegram"
          ? messageText || null
          : channel === "email"
            ? defaultEmailContent?.subject || subjectOverride || null
            : null,
      totalRecipients: recipientsToSend.length,
      sentBy: user.id,
      scenarioId: normalizedScenarioId,
      scenarioNodeId: normalizedScenarioNodeId,
      executionSource: normalizedExecutionSource,
    });

    if (!campaignHistoryInput.success) {
      return NextResponse.json(
        {
          error: "Invalid campaign history payload",
          details: campaignHistoryInput.error.errors,
        },
        { status: 400 }
      );
    }

    const dispatchItems: BulkCampaignDispatchItem[] = [];
    const whatsappHeaderMediaUploadCache: WhatsAppHeaderMediaUploadCache =
      new Map();

    for (const recipient of recipientsToSend) {
      if (channel === "whatsapp") {
        // The conversation keeps the row's real name on a new or placeholder
        // contact; never the phone that {{1}} falls back to.
        const recipientName = resolveCampaignRecipientContactName(recipient);
        if (isWhatsAppServiceText) {
          const normalizedPhone = normalizeCampaignPhone(recipient.phone || "");
          const serviceWindowExpiresAt =
            serviceWindowExpiresAtByPhone[normalizedPhone];
          if (
            !whatsappSendContext?.phoneNumberId ||
            !whatsappSendContext.sourceId ||
            !recipient.phone ||
            !messageText ||
            !serviceWindowExpiresAt
          ) {
            continue;
          }
          dispatchItems.push({
            channel: "whatsapp",
            whatsappMessageType: "service_text",
            workspaceId,
            campaignId,
            executionSource: normalizedExecutionSource,
            sentByUserId: user.id,
            sourceId: whatsappSendContext.sourceId,
            recipient: {
              phone: recipient.phone,
              ...(recipient.email
                ? { email: normalizeCampaignEmail(recipient.email) }
                : {}),
              ...(recipientName ? { name: recipientName } : {}),
            },
            phoneNumberId: whatsappSendContext.phoneNumberId,
            messageText,
            serviceWindowExpiresAt,
          });
          continue;
        }

        const verifiedRoute = verifiedRouteByRecipient.get(recipient);
        const approvedTemplate = approvedTemplateByRecipient.get(recipient);
        if (!approvedTemplate) {
          throw new BulkCampaignEligibilityError("invalid_preflight");
        }
        const recipientTemplateName = approvedTemplate.name;
        const recipientLanguageCode = approvedTemplate.language;
        const recipientScenarioNodeId =
          verifiedRoute?.actionNodeId || normalizedScenarioNodeId;

        if (
          !whatsappSendContext?.phoneNumberId ||
          !recipient.phone ||
          !recipientTemplateName
        ) {
          throw new BulkCampaignEligibilityError("invalid_preflight");
        }

        const { components, missingRequired, headerMediaMissing } =
          resolveBulkSendWhatsappPayload(
            recipient,
            approvedTemplate.components,
            approvedTemplate.requiredTemplateVariables,
            workspaceId,
            campaignId,
            normalizedScenarioId,
            recipientScenarioNodeId,
            approvedTemplate.sourceId,
            recipientTemplateName,
            verifiedRoute?.stepTemplate
          );
        if (headerMediaMissing) {
          throw new BulkCampaignEligibilityError("invalid_preflight");
        }
        if (missingRequired.length > 0) {
          throw new BulkCampaignEligibilityError("invalid_preflight");
        }

        let preparedComponents = components || undefined;
        try {
          preparedComponents =
            await normalizeWhatsAppTemplateHeaderMediaComponents({
              components: preparedComponents,
              phoneNumberId: whatsappSendContext.phoneNumberId,
              accessToken: whatsappSendContext.accessToken,
              cache: whatsappHeaderMediaUploadCache,
            });
        } catch (mediaError) {
          throw new BulkCampaignEligibilityError(
            "dispatchability_unavailable",
            { cause: mediaError }
          );
        }

        dispatchItems.push({
          channel: "whatsapp",
          workspaceId,
          campaignId,
          scenarioId: normalizedScenarioId || undefined,
          scenarioNodeId: recipientScenarioNodeId || undefined,
          executionSource: normalizedExecutionSource,
          sentByUserId: user.id,
          sourceId: approvedTemplate.sourceId,
          recipient: {
            phone: recipient.phone,
            ...(recipient.email
              ? { email: normalizeCampaignEmail(recipient.email) }
              : {}),
            ...(recipientName ? { name: recipientName } : {}),
          },
          phoneNumberId: whatsappSendContext.phoneNumberId,
          templateName: recipientTemplateName,
          languageCode: recipientLanguageCode,
          templateCategory: approvedTemplate.category || undefined,
          marketingMessagePricing:
            marketingMessagePricing?.perMessageBidMultiplier !== undefined
              ? marketingMessagePricing
              : undefined,
          components: preparedComponents,
        });
        continue;
      }

      if (channel === "telegram") {
        if (recipient.chatId) {
          const resolvedTelegramRecipient =
            recipient as ResolvedTelegramBulkCampaignRecipient;
          dispatchItems.push({
            channel: "telegram",
            workspaceId,
            campaignId,
            scenarioId: normalizedScenarioId || undefined,
            scenarioNodeId: normalizedScenarioNodeId || undefined,
            executionSource: normalizedExecutionSource,
            sentByUserId: user.id,
            sourceId:
              (typeof recipient.sourceId === "string" &&
              recipient.sourceId.trim()
                ? recipient.sourceId.trim()
                : telegramSourceData?.id) || undefined,
            ...(resolvedTelegramRecipient.businessConnectionId
              ? {
                  businessConnectionId:
                    resolvedTelegramRecipient.businessConnectionId,
                }
              : {}),
            recipient: {
              chatId: recipient.chatId,
            },
            messageText: personalizeCampaignTelegramMessage(
              messageText || "",
              recipient.variables
            ),
          });
        } else {
          continue;
        }
        continue;
      }

      if (channel === "email") {
        const recipientLocale = resolveRecipientEmailLocale(recipient);
        const baseRecipientVariables = {
          ...(recipient.variables || {}),
          locale: recipientLocale,
          language: recipientLocale,
        };
        const recipientEmailContent = resolveEmailContentForRecipient({
          defaultContent: defaultEmailContent,
          emailContentByLocale,
          locale: recipientLocale,
        });
        if (
          recipient.email &&
          effectiveFromAddress &&
          (templateKey || recipientEmailContent)
        ) {
          const normalizedRecipientEmail = normalizeCampaignEmail(
            recipient.email
          );
          const unsubscribeUrl = buildEmailUnsubscribeUrl({
            baseUrl: appBaseUrl,
            workspaceId,
            campaignId,
            email: normalizedRecipientEmail,
          });
          const recipientVariables = {
            ...baseRecipientVariables,
            unsubscribeUrl,
          };
          dispatchItems.push({
            channel: "email",
            workspaceId,
            campaignId,
            scenarioId: normalizedScenarioId || undefined,
            scenarioNodeId: normalizedScenarioNodeId || undefined,
            executionSource: normalizedExecutionSource,
            sentByUserId: user.id,
            recipient: {
              email: normalizedRecipientEmail,
              variables: recipientVariables,
            },
            fromAddress: effectiveFromAddress,
            templateKey: templateKey || undefined,
            templateModel: buildCampaignEmailTemplateModel({
              templateModel: {
                ...emailTemplateModelDefaults,
                ...(templateModel || {}),
              },
              recipientEmail: normalizedRecipientEmail,
              recipientVariables,
            }),
            subjectOverride: subjectOverride || undefined,
            emailContent: recipientEmailContent,
            messageStream: messageStream || providerConfig?.broadcastStream,
          });
        } else {
          continue;
        }
      }
    }

    if (eligibilityResolution) {
      const retainedIdentities = eligibilityResolution.retained.map(candidate =>
        canonicalizeBulkCampaignRecipientIdentity({
          channel: "whatsapp",
          recipient: candidate.recipient,
        })
      );
      const dispatchIdentities = dispatchItems.map(item =>
        canonicalizeBulkCampaignRecipientIdentity({
          channel: item.channel,
          recipient: item.recipient,
        })
      );
      if (
        dispatchItems.length !== eligibilityResolution.preview.acceptedTotal ||
        JSON.stringify(dispatchIdentities) !==
          JSON.stringify(retainedIdentities)
      ) {
        throw new BulkCampaignEligibilityError("invalid_preflight");
      }
    }

    if (dispatchItems.length === 0) {
      return NextResponse.json(
        {
          error:
            "No recipients were eligible for dispatch after validating template variables and channel requirements.",
        },
        { status: 400 }
      );
    }

    const batchPlan =
      eligibilityResolution?.plan.batchPlan || campaignPlanPreview.batchPlan;
    const eligibilityPreview = eligibilityResolution?.preview;
    const acceptedTotal = dispatchItems.length;
    const acceptedUniqueRecipients = eligibilityPreview
      ? eligibilityPreview.uniqueRecipients.accepted
      : new Set(
          dispatchItems.flatMap(item => {
            const identity = buildBulkCampaignDispatchLogicalRecipientKey(item);
            return identity ? [identity] : [];
          })
        ).size;
    const nonTemplateRequestedTotal =
      channel === "email"
        ? (requestedEmailRecipientTotal ?? requestedTotal)
        : requestedTotal;
    const knownNonTemplateSkipped =
      skippedServiceWindow +
      skippedEmailUnsubscribed +
      skippedRecipientLimit +
      skippedRecentContact;
    const skippedIneligible = eligibilityPreview
      ? 0
      : Math.max(
          0,
          nonTemplateRequestedTotal - acceptedTotal - knownNonTemplateSkipped
        );
    const accumulatedOutcome = eligibilityPreview
      ? null
      : accumulateBulkCampaignEligibilityOutcome({
          requestedTotal: nonTemplateRequestedTotal,
          acceptedTotal,
          uniqueRecipients: {
            requested: Math.max(
              acceptedUniqueRecipients,
              requestedChannelUniqueRecipientTotal
            ),
            accepted: acceptedUniqueRecipients,
          },
          stages: [
            {
              skippedByReason: {
                ...(skippedIneligible > 0
                  ? { ineligible: skippedIneligible }
                  : {}),
                ...(skippedServiceWindow > 0
                  ? { service_window: skippedServiceWindow }
                  : {}),
                ...(skippedEmailUnsubscribed > 0
                  ? { unsubscribed: skippedEmailUnsubscribed }
                  : {}),
                ...(skippedRecipientLimit > 0
                  ? { recipient_limit: skippedRecipientLimit }
                  : {}),
                ...(skippedRecentContact > 0
                  ? { recent_contact: skippedRecentContact }
                  : {}),
              },
              warnings: { missingMarketingConsent: 0 },
            },
          ],
        });
    const requestedOutcomeTotal =
      eligibilityPreview?.requestedTotal || accumulatedOutcome!.requestedTotal;
    const requestedUniqueRecipients =
      eligibilityPreview?.uniqueRecipients.requested ||
      accumulatedOutcome!.uniqueRecipients.requested;
    const skippedByReason = {
      ...(eligibilityPreview?.skippedByReason ||
        accumulatedOutcome!.skippedByReason),
    };
    const outcomeWarnings =
      eligibilityPreview?.warnings || accumulatedOutcome!.warnings;
    const outcomeEvaluatedAt =
      eligibilityPreview?.evaluatedAt || new Date().toISOString();
    const authoritativeLimit =
      eligibilityResolution?.plan.recipientLimit ||
      campaignPlanPreview.recipientLimit;
    const { source: authoritativeLimitSource, maxRecipients } =
      authoritativeLimit;
    const authoritativeRawLimit =
      typeof authoritativeLimit.rawLimit === "string"
        ? authoritativeLimit.rawLimit.trim()
        : "";
    if (
      authoritativeLimitSource === "unavailable" ||
      !Number.isInteger(maxRecipients) ||
      !maxRecipients ||
      maxRecipients <= 0 ||
      !authoritativeRawLimit ||
      authoritativeRawLimit.length > 128
    ) {
      throw new BulkCampaignEligibilityError("plan_unavailable");
    }
    const overflowPlan = buildBulkCampaignOverflowQueuePlan({
      recipientCount: acceptedUniqueRecipients,
      dailyLimit: maxRecipients,
      startAt: schedule.scheduledAtIso || new Date().toISOString(),
    });
    if (overflowPlan.exceedsDailyLimit && overflowQueueConfirmed !== true) {
      return NextResponse.json(
        {
          code: BULK_CAMPAIGN_OVERFLOW_QUEUE_CONFIRMATION_REQUIRED,
          error:
            "This audience is larger than the daily send cap. Confirm to queue remaining recipients in 24-hour waves.",
          overflowQueue: {
            required: true,
            confirmed: false,
            ...overflowPlan,
          },
        },
        { status: 409 }
      );
    }
    const dispatchBatchPlan = overflowPlan.exceedsDailyLimit
      ? { ...batchPlan, dailyWaveLimit: overflowPlan.dailyLimit }
      : batchPlan;
    const policyMetadata: BulkCampaignPolicyAdmissionMetadata = {
      policy: recipientPolicy,
      authoritativeRecipientLimit: {
        source: authoritativeLimitSource,
        value: maxRecipients,
        rawLimit: authoritativeRawLimit,
      },
      batchPlan: dispatchBatchPlan,
      outcome: {
        evaluatedAt: outcomeEvaluatedAt,
        requestedTotal: requestedOutcomeTotal,
        acceptedTotal,
        uniqueRecipients: {
          requested: requestedUniqueRecipients,
          accepted: acceptedUniqueRecipients,
        },
        skippedByReason,
        warnings: outcomeWarnings,
      },
      requestDigest: semanticRequestDigest,
    };
    const audienceSourceType = analyticsAudience
      ? parsedRecipients.length > 0
        ? audienceUploadEvidence
          ? "bulk_analytics_with_upload"
          : "bulk_analytics_with_manual_fill_up"
        : analyticsAudience.type
      : audienceUploadEvidence
        ? "uploaded_file"
        : registeredUsersAudience?.type ||
          registeredBusinessPhonesAudience?.type ||
          telegramSubscribersAudience?.type ||
          (normalizedScenarioId ? "scenario" : "manual");
    // Activate after the request-level rejections above. Admission can still
    // refuse the send, so POST reports the activation on every later response.
    if (builderScenarioActivationTarget && normalizedScenarioId) {
      const activation = await activateBuilderScenarioForSend({
        workspaceId,
        scenarioId: normalizedScenarioId,
        userId: user.id,
        expectedUpdatedAt: builderScenarioActivationTarget.expectedUpdatedAt,
      });
      if (!activation.ok) {
        return NextResponse.json(activation.body, { status: 409 });
      }
      scenarioActivation.fields = {
        scenarioActivated: true,
        scenarioStatus: "active",
        ...(activation.updatedAt
          ? { scenarioUpdatedAt: activation.updatedAt }
          : {}),
        ...(activation.previousUpdatedAt
          ? { previousScenarioUpdatedAt: activation.previousUpdatedAt }
          : {}),
      };
    }
    let queuedDispatch;
    try {
      queuedDispatch = await queuePreparedBulkCampaignDispatch({
        storeClient: supabaseAdmin,
        fingerprintSecret,
        campaignId,
        workspaceId,
        channel,
        campaignName: campaignHistoryInput.data.name,
        templateName: campaignHistoryInput.data.templateName,
        templateLanguage: campaignHistoryInput.data.templateLanguage,
        messageText: campaignHistoryInput.data.messageText,
        sentBy: user.id,
        scenarioId: normalizedScenarioId,
        scenarioNodeId: normalizedScenarioNodeId,
        executionSource: normalizedExecutionSource,
        scheduledAt: schedule.scheduledAtIso,
        batchPlan: dispatchBatchPlan,
        items: dispatchItems,
        audienceSourceType,
        audienceUploadEvidence,
        policyMetadata,
        audienceConfirmationFingerprint,
        requestedTotal: requestedOutcomeTotal,
        skippedOptIn,
        companyBulkCampaignLimit: capacity.limit.bulkRecipientLimit,
        companySubscriptionType: capacity.limit.subscriptionType,
      });
    } catch (error) {
      if (error instanceof PreparedBulkCampaignQueueError) {
        if (
          error.body.code === "bulk_campaign_terminal_replay" &&
          deterministicCampaignId
        ) {
          let immutableTerminalReplay:
            | {
                replay: NonNullable<
                  Awaited<ReturnType<typeof lookupAdmittedBulkCampaignReplay>>
                >;
                dispatchStatus:
                  | "completed"
                  | "failed"
                  | "expired"
                  | "cancelled";
                projection: ReturnType<
                  typeof projectBulkCampaignReplayResponse
                >;
              }
            | undefined;
          try {
            const terminalReplay = await lookupAdmittedBulkCampaignReplay({
              client: admittedReplayClient,
              campaignId: deterministicCampaignId,
              workspaceId,
              sentBy: user.id,
              requestDigest: semanticRequestDigest,
            });
            if (
              terminalReplay &&
              (terminalReplay.dispatchStatus === "completed" ||
                terminalReplay.dispatchStatus === "failed" ||
                terminalReplay.dispatchStatus === "expired" ||
                terminalReplay.dispatchStatus === "cancelled")
            ) {
              immutableTerminalReplay = {
                replay: terminalReplay,
                dispatchStatus: terminalReplay.dispatchStatus,
                projection: projectBulkCampaignReplayResponse(
                  terminalReplay.result
                ),
              };
            }
          } catch {
            // A terminal retry must never fall back to mutable request facts.
            // The stable 409 remains safe when immutable replay facts cannot
            // be recovered for telemetry.
          }

          if (immutableTerminalReplay) {
            const { replay, dispatchStatus, projection } =
              immutableTerminalReplay;
            if (
              dispatchStatus === "completed" &&
              projection.result.outcome.disposition === "no_op" &&
              projection.result.outcome.lifecycleStatus === "completed"
            ) {
              const replayEventFacts =
                createBulkCampaignAdmittedReplayPolicyEventFacts({
                  replay,
                  outcome: projection.result.outcome,
                });
              return await respondAdmittedReplay(
                replayEventFacts,
                projection.responseBody
              );
            }

            emitBulkCampaignPolicyEvent(
              logger,
              createBulkCampaignTerminalReplayPolicyEvent({
                replay,
                outcome: projection.result.outcome,
                dispatchStatus,
              })
            );
          } else {
            emitBulkCampaignPolicyEvent(
              logger,
              createBulkCampaignTerminalReplayFactsUnavailableEvent({
                workspaceId,
              })
            );
          }
        } else if (error.body.code !== "bulk_campaign_terminal_replay") {
          emitBulkCampaignPolicyEvent(logger, {
            workspaceId,
            channel,
            messageKind:
              channel === "whatsapp"
                ? isWhatsAppServiceText
                  ? "service_text"
                  : "template"
                : channel,
            executionSource: normalizedExecutionSource,
            scenarioId: normalizedScenarioId,
            rootNodeId: normalizedScenarioNodeId,
            itemCounts: {
              requested: requestedOutcomeTotal,
              accepted: acceptedTotal,
              queued: 0,
            },
            uniqueRecipientCounts: {
              requested: requestedUniqueRecipients,
              accepted: acceptedUniqueRecipients,
              queued: 0,
            },
            skippedByReason,
            warnings: outcomeWarnings,
            disposition: "blocked",
            lifecycleStatus: null,
            planLimit: {
              source: authoritativeLimitSource,
              value: maxRecipients,
            },
            policy: recipientPolicy,
            errorCode: error.body.code,
            idempotentReplay: false,
          });
        }
        return NextResponse.json(error.body, { status: error.httpStatus });
      }
      throw error;
    }
    if (
      idempotencyKey &&
      deterministicCampaignId &&
      queuedDispatch.idempotentReplay
    ) {
      let admittedReplay;
      try {
        admittedReplay = await lookupAdmittedBulkCampaignReplay({
          client: admittedReplayClient,
          campaignId: deterministicCampaignId,
          workspaceId,
          sentBy: user.id,
          requestDigest: semanticRequestDigest,
        });
      } catch (error) {
        if (error instanceof BulkCampaignAdmissionPayloadMismatchError) {
          return bulkCampaignIdempotencyPayloadMismatchResponse();
        }
        if (!(error instanceof BulkCampaignAdmissionUnavailableError)) {
          throw error;
        }
        admittedReplay = null;
      }
      if (!admittedReplay) {
        return bulkCampaignIdempotencyUnavailableResponse("recovered");
      }
      let replayProjection: ReturnType<
        typeof projectBulkCampaignReplayResponse
      >;
      try {
        replayProjection = projectBulkCampaignReplayResponse(
          admittedReplay.result
        );
      } catch {
        return bulkCampaignIdempotencyUnavailableResponse("recovered");
      }
      const { result: replayResult, responseBody: replayResponseBody } =
        replayProjection;
      if (
        (admittedReplay.dispatchStatus === "completed" ||
          admittedReplay.dispatchStatus === "failed" ||
          admittedReplay.dispatchStatus === "expired" ||
          admittedReplay.dispatchStatus === "cancelled") &&
        !(
          admittedReplay.dispatchStatus === "completed" &&
          replayResult.outcome.disposition === "no_op" &&
          replayResult.outcome.lifecycleStatus === "completed"
        )
      ) {
        const terminalError = createPreparedBulkCampaignTerminalReplayError({
          campaignId: admittedReplay.campaignId,
          dispatchStatus: admittedReplay.dispatchStatus,
        });
        emitBulkCampaignPolicyEvent(
          logger,
          createBulkCampaignTerminalReplayPolicyEvent({
            replay: admittedReplay,
            outcome: replayResult.outcome,
            dispatchStatus: admittedReplay.dispatchStatus,
          })
        );
        return NextResponse.json(terminalError.body, {
          status: terminalError.httpStatus,
        });
      }
      const replayEventFacts = createBulkCampaignAdmittedReplayPolicyEventFacts(
        {
          replay: admittedReplay,
          outcome: replayResult.outcome,
        }
      );
      return await respondAdmittedReplay(replayEventFacts, replayResponseBody);
    }
    if (recipientLimitMeta) {
      recipientLimitMeta.acceptedCount = queuedDispatch.total;
    }

    let scenarioActivated = false;
    if (
      isLegacyBulkCampaignScenario &&
      normalizedScenarioId &&
      Types.ObjectId.isValid(normalizedScenarioId) &&
      normalizedExecutionSource === "scenario_run_now"
    ) {
      try {
        const activationResult = await Scenario.updateOne(
          {
            _id: new Types.ObjectId(normalizedScenarioId),
            workspaceId,
            mode: "bulk_campaign",
            status: "draft",
            deletedAt: null,
            $nor: [
              {
                nodes: {
                  $elemMatch: {
                    "data.kind": "trigger",
                    "data.triggerConfig.entryPointType": "whatsapp_qr",
                  },
                },
              },
            ],
          },
          {
            $set: {
              status: "active",
              updatedBy: user.id,
            },
          }
        );
        scenarioActivated = Number(activationResult?.modifiedCount || 0) > 0;
      } catch (activationError) {
        // Dispatch is already safely queued; scenario activation is best effort.
        // eslint-disable-next-line no-console
        console.error("Failed to activate queued bulk campaign scenario", {
          workspaceId,
          scenarioId: normalizedScenarioId,
          campaignId,
          error:
            activationError instanceof Error
              ? activationError.message
              : String(activationError),
        });
      }
    }

    const canonicalResult = createBulkCampaignSuccessResult({
      disposition: schedule.scheduled ? "scheduled" : "queued",
      evaluatedAt: outcomeEvaluatedAt,
      lifecycleStatus: queuedDispatch.status,
      requestedTotal: requestedOutcomeTotal,
      acceptedTotal,
      queuedTotal: queuedDispatch.total,
      uniqueRecipients: {
        requested: requestedUniqueRecipients,
        accepted: acceptedUniqueRecipients,
        queued: acceptedUniqueRecipients,
      },
      skippedByReason,
      warnings: outcomeWarnings,
      campaignId: queuedDispatch.campaignId,
      dispatchId: queuedDispatch.dispatchId,
      workflowId: queuedDispatch.workflowId,
    });
    const responseBody: Record<string, unknown> = {
      ...serializeBulkCampaignCommandResult(canonicalResult),
      ...(schedule.scheduledAtIso
        ? { scheduledAt: schedule.scheduledAtIso }
        : {}),
      audience: queuedDispatch.audience,
      audienceConfirmation: queuedDispatch.audienceConfirmation,
      batchPlan: dispatchBatchPlan,
      ...(overflowPlan.exceedsDailyLimit
        ? { overflowQueue: overflowPlan }
        : {}),
      temporalDispatchStaging: queuedDispatch.temporalDispatchStaging,
      recipientLimit: recipientLimitMeta,
      message: schedule.scheduledAtIso
        ? "Campaign scheduled in Temporal. Messages will be sent at the selected date."
        : "Campaign queued in Temporal. Messages will be sent in the background. Check campaign history for delivery status.",
      ...(scenarioActivated
        ? { scenarioActivated: true, scenarioStatus: "active" }
        : {}),
      // A same-key replay restores only scenarioActivated/scenarioStatus; the
      // builder sends each campaign with a fresh key, so it never replays.
      ...scenarioActivation.fields,
      ...(channel === "whatsapp"
        ? {
            requestedTotal,
            skippedOptIn,
            ...(excludePriorFailedBulkSends ? { skippedPriorFailed } : {}),
            ...(isWhatsAppServiceText ? { skippedServiceWindow } : {}),
          }
        : {}),
      ...(channel === "email" && skippedEmailUnsubscribed > 0
        ? {
            requestedTotal: requestedEmailRecipientTotal ?? requestedTotal,
            skippedUnsubscribed: skippedEmailUnsubscribed,
          }
        : {}),
    };

    const eventFacts: Omit<
      BulkCampaignPolicyEvent,
      "workspaceId" | "idempotentReplay"
    > = {
      channel,
      messageKind:
        channel === "whatsapp"
          ? isWhatsAppServiceText
            ? "service_text"
            : "template"
          : channel,
      executionSource: normalizedExecutionSource,
      scenarioId: normalizedScenarioId,
      rootNodeId: normalizedScenarioNodeId,
      itemCounts: {
        requested: requestedOutcomeTotal,
        accepted: acceptedTotal,
        queued: queuedDispatch.total,
      },
      uniqueRecipientCounts: {
        requested: requestedUniqueRecipients,
        accepted: acceptedUniqueRecipients,
        queued: acceptedUniqueRecipients,
      },
      skippedByReason,
      warnings: outcomeWarnings,
      disposition: schedule.scheduled ? "scheduled" : "queued",
      lifecycleStatus: queuedDispatch.status,
      planLimit: {
        source: authoritativeLimitSource,
        value: maxRecipients,
      },
      policy: recipientPolicy,
    };

    if (legacyReservationOwner) {
      try {
        legacyReservationCompleted = await completeLegacyBulkSendOperation({
          ...legacyReservationOwner,
          responseBody,
          eventFacts,
        });
        if (!legacyReservationCompleted) {
          throw new Error("Legacy idempotency owner changed before completion");
        }
      } catch (idempotencyStoreError) {
        // Temporal has already accepted this dispatch. A cache failure must not
        // turn an accepted campaign into an ambiguous client-visible 500.
        // eslint-disable-next-line no-console
        console.error("Failed to cache accepted bulk-send idempotency result", {
          workspaceId,
          campaignId: queuedDispatch.campaignId,
          error:
            idempotencyStoreError instanceof Error
              ? idempotencyStoreError.message
              : String(idempotencyStoreError),
        });
      }
    }

    emitBulkCampaignPolicyEvent(logger, {
      ...eventFacts,
      workspaceId,
      idempotentReplay: queuedDispatch.idempotentReplay,
    });

    return NextResponse.json(responseBody);
  } catch (error) {
    if (
      error instanceof BulkCampaignEligibilityError ||
      error instanceof BulkRecipientPolicyError
    ) {
      logBulkCampaignEligibilityFailure(
        logger,
        error,
        failureEventContext?.workspaceId ?? null
      );
      if (failureEventContext) {
        emitBulkCampaignPolicyEvent(logger, {
          ...failureEventContext,
          itemCounts: { requested: 0, accepted: 0, queued: 0 },
          uniqueRecipientCounts: { requested: 0, accepted: 0, queued: 0 },
          skippedByReason: {},
          warnings: { missingMarketingConsent: 0 },
          disposition: "blocked",
          lifecycleStatus: null,
          planLimit: { source: "unavailable", value: null },
          errorCode: error.code,
          idempotentReplay: false,
        });
      }
      const result = createBulkCampaignErrorResult({
        disposition: "blocked",
        code: error.code,
        message: error.message,
      });
      const retryAfterSeconds = bulkCampaignEligibilityRetryAfterSeconds(error);
      return NextResponse.json(
        {
          ...serializeBulkCampaignCommandResult(result),
          ...(retryAfterSeconds === null ? {} : { retryAfterSeconds }),
        },
        {
          status: bulkCampaignEligibilityErrorStatus(error.code),
          ...(retryAfterSeconds === null
            ? {}
            : { headers: { "Retry-After": String(retryAfterSeconds) } }),
        }
      );
    }
    // The capability check above answers its own failures. One that reaches
    // here came from routing the rows, such as a row whose column-split path
    // or Else is not connected to a template, so answer it the same way.
    if (error instanceof BulkCampaignProvenanceError) {
      logger.warn("bulk_campaign.provenance_invalid", {
        workspaceId: failureEventContext?.workspaceId,
        stage: "recipient_routing",
        reason: error.reason,
      });
      return NextResponse.json(
        {
          code: "bulk_campaign_provenance_invalid",
          error: "Bulk campaign provenance could not be verified.",
        },
        { status: 403 }
      );
    }
    // eslint-disable-next-line no-console
    console.error("Bulk send error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  } finally {
    if (legacyReservationOwner && !legacyReservationCompleted) {
      try {
        await releaseLegacyBulkSendOperation(legacyReservationOwner);
      } catch (releaseError) {
        // Best effort: the bounded lease permits a safe retry after expiry.
        // eslint-disable-next-line no-console
        console.error("Failed to release bulk-send idempotency reservation", {
          workspaceId: legacyReservationOwner.workspaceId,
          error:
            releaseError instanceof Error
              ? releaseError.message
              : String(releaseError),
        });
      }
    }
  }
}
