import type {
  BulkAnalyticsVariableSourceConfig,
  BulkAnalyticsVariableSourceMode,
} from "@/lib/analytics/bulk-analytics-contract";
import type {
  BulkCampaignAnalyticsAudienceIntent,
  BulkCampaignAudienceIntent,
  BulkCampaignCommandResult,
  BulkCampaignDispatchExecutionSource,
  BulkCampaignProvenanceIntent,
  BulkCampaignRecipientPolicy,
  CampaignVariableSourceConfig,
  ScenarioCampaignRecipient,
} from "@icecore/scenario-contracts";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import type { SWRConfiguration } from "swr";
import {
  resolveCampaignVariablesForRecipient,
  type CampaignRecipientLike,
} from "./campaign-variable-values";
import {
  MAX_INLINE_BULK_CAMPAIGN_REQUEST_BYTES,
  parseBulkCampaignSendRequest,
} from "./bulk-campaign-contracts";
import type {
  BulkCampaignChannel,
  BulkCampaignRecipient,
  BulkCampaignAudienceOverlapInfo,
  BulkCampaignAudienceUploadEvidence,
  BulkCampaignSendRequest,
  BulkCampaignSendResponse,
} from "./bulk-campaign-contracts";
import {
  readBulkCampaignOverflowQueuePayload,
  type BulkCampaignOverflowQueueConfirmation,
} from "./bulk-campaign-overflow-queue";
import {
  createBulkCampaignErrorResult,
  parseBulkCampaignCommandResult,
  serializeBulkCampaignCommandResult,
} from "./bulk-campaign-outcome";

type FetchLike = typeof fetch;

export type BulkCampaignTemplateInput = {
  name: string;
  language?: string;
  category?: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  components?: WhatsAppComponent[];
};

export type BulkCampaignScenarioSendContext = {
  scenarioId: string;
  scenarioNodeId: string;
  executionSource: BulkCampaignDispatchExecutionSource;
};

export type PrepareCampaignRecipientsForTemplateResult = {
  recipients: CampaignRecipientLike[];
  unresolved: Array<{
    label: string;
    missingVariables: string[];
  }>;
};

export class BulkCampaignSendError extends Error {
  public readonly code: string | null;
  public readonly audienceFingerprint: string | null;
  public readonly confirmationRequired: boolean;
  public readonly overflowQueue: BulkCampaignOverflowQueueConfirmation | null;
  public readonly overlap: BulkCampaignAudienceOverlapInfo | null;
  /** Validation code that kept the send from activating its scenario. */
  public readonly reasonCode: string | null;
  /** Scenario steps that code names. */
  public readonly nodeIds: string[];
  public readonly result: Extract<
    BulkCampaignCommandResult,
    { ok: false }
  > | null;

  constructor(
    message: string,
    public readonly payload: unknown,
    public readonly status: number,
    result?: Extract<BulkCampaignCommandResult, { ok: false }>
  ) {
    super(message);
    this.name = "BulkCampaignSendError";
    const errorPayload =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
    const audience =
      errorPayload.audience &&
      typeof errorPayload.audience === "object" &&
      !Array.isArray(errorPayload.audience)
        ? (errorPayload.audience as Record<string, unknown>)
        : {};
    const confirmation =
      errorPayload.audienceConfirmation &&
      typeof errorPayload.audienceConfirmation === "object" &&
      !Array.isArray(errorPayload.audienceConfirmation)
        ? (errorPayload.audienceConfirmation as Record<string, unknown>)
        : {};
    this.result = result || null;
    this.code =
      typeof errorPayload.code === "string"
        ? errorPayload.code
        : result?.code || null;
    this.audienceFingerprint =
      typeof audience.fingerprint === "string" ? audience.fingerprint : null;
    this.confirmationRequired = confirmation.required === true;
    this.reasonCode =
      typeof errorPayload.reasonCode === "string"
        ? errorPayload.reasonCode
        : null;
    this.nodeIds = Array.isArray(errorPayload.nodeIds)
      ? errorPayload.nodeIds.filter(
          (nodeId): nodeId is string => typeof nodeId === "string"
        )
      : [];
    this.overflowQueue = readBulkCampaignOverflowQueuePayload(errorPayload);
    const overlap =
      audience.overlap &&
      typeof audience.overlap === "object" &&
      !Array.isArray(audience.overlap)
        ? (audience.overlap as Record<string, unknown>)
        : {};
    this.overlap =
      typeof overlap.intersectionCount === "number" &&
      typeof overlap.candidateCount === "number" &&
      typeof overlap.ratio === "number"
        ? {
            ...(overlap.kind === "none" ||
            overlap.kind === "high" ||
            overlap.kind === "exact" ||
            overlap.kind === "unknown"
              ? { kind: overlap.kind }
              : {}),
            intersectionCount: overlap.intersectionCount,
            candidateCount: overlap.candidateCount,
            ratio: overlap.ratio,
          }
        : null;
  }
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function serializeBulkCampaignInlineRequest(payload: unknown): string {
  const body = JSON.stringify(payload);
  if (body === undefined) {
    throw new TypeError("Bulk campaign request must be JSON serializable");
  }

  const actualBytes = utf8ByteLength(body);
  if (actualBytes > MAX_INLINE_BULK_CAMPAIGN_REQUEST_BYTES) {
    throw new BulkCampaignSendError(
      "This inline recipient list is too large for one request. Reduce the upload or use a server-resolved Analytics audience.",
      {
        code: "bulk_campaign_inline_payload_too_large",
        actualBytes,
        maxBytes: MAX_INLINE_BULK_CAMPAIGN_REQUEST_BYTES,
      },
      413
    );
  }

  return body;
}

export function createBulkCampaignIdempotencyKey(): string {
  return (
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export function buildBulkCampaignBatchPlanUrl(params: {
  workspaceId: string;
  channel: BulkCampaignChannel;
  sourceId?: string;
}): string {
  const searchParams = new URLSearchParams({
    workspaceId: params.workspaceId,
    channel: params.channel,
  });
  if (params.channel === "whatsapp" && params.sourceId?.trim()) {
    searchParams.set("sourceId", params.sourceId.trim());
  }
  return `/api/campaigns/batch-plan?${searchParams.toString()}`;
}

/**
 * A failed bulk-campaign read that keeps the server's error code and retry
 * hint, so the UI can say why a check failed.
 */
export class BulkCampaignRequestError extends Error {
  /** Epoch ms before which a retry is pointless; null without a hint. */
  public readonly retryAt: number | null;

  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
    public readonly retryAfterSeconds: number | null
  ) {
    super(message);
    this.name = "BulkCampaignRequestError";
    this.retryAt =
      retryAfterSeconds === null
        ? null
        : Date.now() + retryAfterSeconds * 1_000;
  }
}

/** How long a remount or a repeated key reuses a check that reads Meta. */
export const BULK_CAMPAIGN_CHECK_REUSE_MS = 60_000;

/**
 * SWR options for checks that read Meta on the WhatsApp account, which Meta
 * throttles. They re-check on Refresh (`mutate`) and on a key not checked in
 * the last minute, never on focus, reconnect or error, and a remount waits
 * out a failed check's Retry-After.
 */
export function bulkCampaignCheckSWROptions(
  cachedError: unknown
): SWRConfiguration {
  const retryLocked =
    cachedError instanceof BulkCampaignRequestError &&
    cachedError.retryAt !== null &&
    cachedError.retryAt > Date.now();
  return {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    shouldRetryOnError: false,
    dedupingInterval: BULK_CAMPAIGN_CHECK_REUSE_MS,
    ...(retryLocked ? { revalidateOnMount: false } : {}),
  };
}

function positiveSeconds(value: unknown): number | null {
  const seconds =
    typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value)
      : value;
  return typeof seconds === "number" &&
    Number.isSafeInteger(seconds) &&
    seconds > 0
    ? seconds
    : null;
}

/**
 * Reads `{ error: "text" }` or `{ error: { code } }`, and the retry delay from
 * `retryAfterSeconds` or the Retry-After header.
 */
export function readBulkCampaignResponseError(
  response: Pick<Response, "status" | "headers">,
  payload: unknown,
  fallbackMessage: string
): BulkCampaignRequestError {
  const body =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const error = body.error;
  const code =
    error &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : null;
  // Test doubles and some proxies return responses without headers.
  const retryAfterHeader =
    typeof response.headers?.get === "function"
      ? response.headers.get("Retry-After")
      : null;
  return new BulkCampaignRequestError(
    typeof error === "string" && error ? error : fallbackMessage,
    response.status,
    code,
    positiveSeconds(body.retryAfterSeconds) ?? positiveSeconds(retryAfterHeader)
  );
}

export async function bulkCampaignJsonFetcher<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw readBulkCampaignResponseError(response, payload, "Failed to fetch");
  }
  return payload as T;
}

function recipientLabel(
  recipient: CampaignRecipientLike,
  index: number
): string {
  return (
    recipient.phone || recipient.chatId || recipient.email || `row ${index + 1}`
  );
}

export function prepareCampaignRecipientsForTemplate(params: {
  recipients: CampaignRecipientLike[];
  templateVariables: string[];
  variableConfigs: Record<string, CampaignVariableSourceConfig>;
}): PrepareCampaignRecipientsForTemplateResult {
  const unresolved: PrepareCampaignRecipientsForTemplateResult["unresolved"] =
    [];
  const recipients = params.recipients.map((recipient, index) => {
    const resolved = resolveCampaignVariablesForRecipient({
      recipient,
      templateVariables: params.templateVariables,
      variableConfigs: params.variableConfigs,
    });

    if (resolved.missingVariables.length > 0) {
      unresolved.push({
        label: recipientLabel(recipient, index),
        missingVariables: resolved.missingVariables,
      });
    }

    return resolved.recipient;
  });

  return { recipients, unresolved };
}

export function formatMissingCampaignVariableLines(
  unresolved: PrepareCampaignRecipientsForTemplateResult["unresolved"]
): string[] {
  return unresolved.map(
    item =>
      `${item.label}: ${item.missingVariables
        .map(variable => `{{${variable}}}`)
        .join(", ")}`
  );
}

const MISSING_CAMPAIGN_VARIABLE_PREVIEW_LINES = 3;

/** A summary line, the first few recipients, then "and N more". */
export function formatMissingCampaignVariablesMessage(
  unresolved: PrepareCampaignRecipientsForTemplateResult["unresolved"],
  copy: {
    summary: (count: number) => string;
    more: (count: number) => string;
  }
): string {
  const lines = formatMissingCampaignVariableLines(unresolved);
  const hiddenCount = lines.length - MISSING_CAMPAIGN_VARIABLE_PREVIEW_LINES;
  return [
    copy.summary(unresolved.length),
    ...lines.slice(0, MISSING_CAMPAIGN_VARIABLE_PREVIEW_LINES),
    ...(hiddenCount > 0 ? [copy.more(hiddenCount)] : []),
  ].join("\n");
}

export function buildBulkAnalyticsVariableConfigs(params: {
  templateVariables: string[];
  variableConfigs: Record<string, CampaignVariableSourceConfig>;
}): {
  variableConfigs: Record<string, BulkAnalyticsVariableSourceConfig>;
  missingCustomVariables: string[];
} {
  const variableConfigs: Record<string, BulkAnalyticsVariableSourceConfig> = {};
  const missingCustomVariables: string[] = [];

  params.templateVariables.forEach(variable => {
    const config = params.variableConfigs[variable] || { mode: "auto" };
    if (config.mode === "custom") {
      const customValue = config.customValue?.trim() || "";
      if (!customValue) {
        missingCustomVariables.push(variable);
        return;
      }
      variableConfigs[variable] = { mode: "custom", customValue };
      return;
    }

    if (isBulkAnalyticsVariableSourceMode(config.mode)) {
      variableConfigs[variable] = { mode: config.mode };
    }
  });

  return { variableConfigs, missingCustomVariables };
}

function isBulkAnalyticsVariableSourceMode(
  value: string
): value is Exclude<BulkAnalyticsVariableSourceMode, "auto" | "custom"> {
  return value === "contact_name" || value === "recipient_phone";
}

export type BulkCampaignLegacySendRequestParams = {
  workspaceId: string;
  channel: BulkCampaignChannel;
  campaignName?: string;
  idempotencyKey?: string;
  recipients?: BulkCampaignRecipient[];
  analyticsAudience?: BulkCampaignSendRequest["analyticsAudience"];
  registeredUsersAudience?: BulkCampaignSendRequest["registeredUsersAudience"];
  registeredBusinessPhonesAudience?: BulkCampaignSendRequest["registeredBusinessPhonesAudience"];
  telegramSubscribersAudience?: BulkCampaignSendRequest["telegramSubscribersAudience"];
  whatsappTemplate?: BulkCampaignTemplateInput;
  whatsappMessageType?: "template" | "service_text";
  whatsappSourceId?: string;
  messageText?: string;
  email?: {
    templateKey?: "announcement" | "product_update" | "event_reminder";
    templateModel?: Record<string, string>;
    subjectOverride?: string;
    content?: BulkCampaignSendRequest["emailContent"];
    contentByLocale?: BulkCampaignSendRequest["emailContentByLocale"];
  };
  scenario?: BulkCampaignScenarioSendContext;
  scheduledAt?: string | null;
  useColumnSplitRouting?: boolean;
  audienceConfirmationFingerprint?: string;
  overflowQueueConfirmed?: boolean;
  providerCircuitAcknowledged?: boolean;
  audienceUploadEvidence?: BulkCampaignAudienceUploadEvidence;
  excludePriorFailedBulkSends?: boolean;
};

export type BulkCampaignAdHocAudienceMode =
  | "analytics"
  | "registered_users"
  | "registered_business_phones"
  | "telegram_subscribers"
  | "inline";

export type BuildBulkCampaignAudienceIntentParams = {
  analyticsSource?: {
    filters: BulkCampaignAnalyticsAudienceIntent["filters"];
    previewCount?: number | null;
  } | null;
  fillUpRecipients?: ScenarioCampaignRecipient[];
  analyticsVariableConfigs?: BulkCampaignAnalyticsAudienceIntent["variableConfigs"];
  selectedRegisteredUserIds?: string[] | null;
  selectedPhones?: string[] | null;
  telegramSourceId?: string | null;
  telegramSelectedChatIds?: string[];
  inlineRecipients?: ScenarioCampaignRecipient[];
  uploadEvidence?: BulkCampaignAudienceUploadEvidence | null;
};

export function buildBulkCampaignAudienceIntent(
  mode: BulkCampaignAdHocAudienceMode,
  params: BuildBulkCampaignAudienceIntentParams = {}
): BulkCampaignAudienceIntent | undefined {
  switch (mode) {
    case "analytics": {
      if (!params.analyticsSource) return undefined;
      return {
        kind: "analytics_with_fill_up",
        analytics: {
          filters: params.analyticsSource.filters,
          ...(params.analyticsSource.previewCount !== undefined
            ? { previewCount: params.analyticsSource.previewCount }
            : {}),
          ...(params.analyticsVariableConfigs
            ? { variableConfigs: params.analyticsVariableConfigs }
            : {}),
        },
        fillUpRecipients: params.fillUpRecipients ?? [],
      };
    }
    case "registered_users":
      return {
        kind: "registered_users",
        ...(params.selectedRegisteredUserIds?.length
          ? { selectedUserIds: params.selectedRegisteredUserIds }
          : {}),
      };
    case "registered_business_phones":
      return {
        kind: "registered_business_phones",
        ...(params.selectedPhones?.length
          ? { selectedPhones: params.selectedPhones }
          : {}),
      };
    case "telegram_subscribers": {
      const sourceId = params.telegramSourceId?.trim();
      if (!sourceId) return undefined;
      return {
        kind: "telegram_subscribers",
        sourceId,
        ...(params.telegramSelectedChatIds?.length
          ? { selectedChatIds: params.telegramSelectedChatIds }
          : {}),
      };
    }
    case "inline": {
      const recipients = params.inlineRecipients ?? [];
      if (recipients.length === 0) return undefined;
      return {
        kind: "inline",
        recipients,
        ...(params.uploadEvidence
          ? { uploadEvidence: params.uploadEvidence }
          : {}),
      };
    }
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

export type BulkCampaignCanonicalSendRequestParams = Omit<
  BulkCampaignLegacySendRequestParams,
  | "recipients"
  | "analyticsAudience"
  | "registeredUsersAudience"
  | "registeredBusinessPhonesAudience"
  | "telegramSubscribersAudience"
  | "scenario"
  | "audienceUploadEvidence"
  | "excludePriorFailedBulkSends"
> & {
  audience: BulkCampaignAudienceIntent;
  recipientPolicy?: BulkCampaignRecipientPolicy;
  provenance?: BulkCampaignProvenanceIntent;
};

export function buildBulkCampaignSendRequest(
  params: BulkCampaignCanonicalSendRequestParams
): BulkCampaignSendRequest;
/** @deprecated Use the canonical audience, recipientPolicy, and provenance fields. */
export function buildBulkCampaignSendRequest(
  params: BulkCampaignLegacySendRequestParams
): BulkCampaignSendRequest;
export function buildBulkCampaignSendRequest(
  params:
    | BulkCampaignCanonicalSendRequestParams
    | BulkCampaignLegacySendRequestParams
): BulkCampaignSendRequest {
  return {
    workspaceId: params.workspaceId,
    channel: params.channel,
    ...(params.campaignName ? { campaignName: params.campaignName } : {}),
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    ...(params.useColumnSplitRouting ? { useColumnSplitRouting: true } : {}),
    ...(params.audienceConfirmationFingerprint
      ? {
          audienceConfirmationFingerprint:
            params.audienceConfirmationFingerprint,
        }
      : {}),
    ...(params.overflowQueueConfirmed ? { overflowQueueConfirmed: true } : {}),
    ...(params.providerCircuitAcknowledged
      ? { providerCircuitAcknowledged: true }
      : {}),
    ...("audienceUploadEvidence" in params && params.audienceUploadEvidence
      ? { audienceUploadEvidence: params.audienceUploadEvidence }
      : {}),
    ...("excludePriorFailedBulkSends" in params &&
    params.excludePriorFailedBulkSends
      ? { excludePriorFailedBulkSends: true }
      : {}),
    ...("provenance" in params && params.provenance
      ? { provenance: params.provenance }
      : {}),
    ...("recipientPolicy" in params && params.recipientPolicy
      ? { recipientPolicy: params.recipientPolicy }
      : {}),
    ...("scenario" in params && params.scenario
      ? {
          scenarioId: params.scenario.scenarioId,
          scenarioNodeId: params.scenario.scenarioNodeId,
          executionSource: params.scenario.executionSource,
        }
      : {}),
    ...(params.scheduledAt ? { scheduledAt: params.scheduledAt } : {}),
    ...(params.whatsappTemplate
      ? {
          templateName: params.whatsappTemplate.name,
          languageCode: params.whatsappTemplate.language || "en",
          templateCategory: params.whatsappTemplate.category,
          templateComponents: params.whatsappTemplate.components,
        }
      : {}),
    ...(params.whatsappMessageType
      ? { whatsappMessageType: params.whatsappMessageType }
      : {}),
    ...(params.whatsappSourceId?.trim()
      ? { whatsappSourceId: params.whatsappSourceId.trim() }
      : {}),
    ...(params.messageText ? { messageText: params.messageText } : {}),
    ...(params.email
      ? {
          templateKey: params.email.templateKey,
          templateModel: params.email.templateModel,
          subjectOverride: params.email.subjectOverride || undefined,
          emailContent: params.email.content,
          emailContentByLocale: params.email.contentByLocale,
        }
      : {}),
    ...("audience" in params
      ? { audience: params.audience }
      : "registeredBusinessPhonesAudience" in params &&
          params.registeredBusinessPhonesAudience
        ? {
            registeredBusinessPhonesAudience:
              params.registeredBusinessPhonesAudience,
            recipients: params.recipients || [],
          }
        : "telegramSubscribersAudience" in params &&
            params.telegramSubscribersAudience
          ? {
              telegramSubscribersAudience: params.telegramSubscribersAudience,
              recipients: params.recipients || [],
            }
          : "registeredUsersAudience" in params &&
              params.registeredUsersAudience
            ? {
                registeredUsersAudience: params.registeredUsersAudience,
                recipients: params.recipients || [],
              }
            : "analyticsAudience" in params && params.analyticsAudience
              ? {
                  analyticsAudience: params.analyticsAudience,
                  recipients: params.recipients || [],
                }
              : {
                  recipients:
                    ("recipients" in params && params.recipients) || [],
                }),
  };
}

export async function postBulkCampaignSend(
  request: BulkCampaignSendRequest,
  fetchImpl: FetchLike = fetch
): Promise<BulkCampaignSendClientSuccess> {
  const normalizedRequest = parseBulkCampaignSendRequest(request);
  // The route parses the posted body again, and its contract has no
  // legacy_scenario_run_now provenance, so the legacy scenarioId and
  // scenarioNodeId fields would be refused there. Refuse them here, by name.
  if (normalizedRequest.provenance.kind === "legacy_scenario_run_now") {
    throw new TypeError(
      "Scenario bulk sends need provenance (scenarioId and rootNodeId), not the legacy scenarioId and scenarioNodeId fields"
    );
  }
  const body = serializeBulkCampaignInlineRequest(normalizedRequest);
  const response = await fetchImpl("/api/campaigns/bulk-send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const payload = await response.json().catch(() => null);

  let result: BulkCampaignCommandResult;
  try {
    result = parseBulkCampaignCommandResult({
      payload,
      httpStatus: response.status,
    });
  } catch (error) {
    const malformedResult = createBulkCampaignErrorResult({
      disposition: "failed",
      code: "bulk_campaign_malformed_response",
      message:
        error instanceof Error
          ? error.message
          : "Malformed bulk campaign response",
    });
    throw new BulkCampaignSendError(
      malformedResult.message,
      payload,
      response.status,
      malformedResult
    );
  }

  if (!response.ok || !result.ok) {
    const errorResult = result.ok
      ? createBulkCampaignErrorResult({
          disposition: "failed",
          code: "bulk_campaign_malformed_response",
          message: "Malformed bulk campaign error response",
        })
      : result;
    throw new BulkCampaignSendError(
      errorResult.message,
      payload,
      response.status,
      errorResult
    );
  }

  return {
    ...(payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : {}),
    ...serializeBulkCampaignCommandResult(result),
  } as BulkCampaignSendClientSuccess;
}

export type BulkCampaignSendClientSuccess = Extract<
  BulkCampaignCommandResult,
  { ok: true }
> &
  BulkCampaignSendResponse;
