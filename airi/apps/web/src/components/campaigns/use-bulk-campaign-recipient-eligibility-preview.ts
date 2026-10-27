"use client";

import {
  BulkCampaignRequestError,
  bulkCampaignCheckSWROptions,
  readBulkCampaignResponseError,
  serializeBulkCampaignInlineRequest,
} from "@/lib/campaign/bulk-campaign-client";
import { appendBulkAnalyticsAudienceFiltersToSearchParams } from "@/lib/analytics/bulk-analytics-contract";
import type {
  BulkCampaignAudienceIntent,
  BulkCampaignEligibilityMessageIntent,
  BulkCampaignProvenanceIntent,
  BulkCampaignRecipientPolicy,
  BulkCampaignSkipReason,
  BulkCampaignReadiness,
} from "@icecore/scenario-contracts";
import { isBulkCampaignReadiness } from "@icecore/scenario-contracts";
import { useCallback, useEffect, useMemo, useRef } from "react";
import useSWR, { useSWRConfig } from "swr";
import { isRecord } from "@icecore/shared/lib/value-utils";

export type BulkCampaignEligibilityPreview = {
  state: "ready";
  /** Null when a legacy response cannot prove when local eligibility was checked. */
  evaluatedAt: string | null;
  requestedTotal: number;
  acceptedTotal: number;
  uniqueRecipients: { requested: number; accepted: number };
  skippedByReason: Partial<Record<BulkCampaignSkipReason, number>>;
  warnings: { missingMarketingConsent: number };
  allExcluded: boolean;
  readiness: BulkCampaignReadiness;
};

export type BulkCampaignEligibilityPreviewState =
  | { state: "idle"; canSubmit: true }
  | { state: "loading"; canSubmit: false; retry: () => void }
  | {
      state: "ready";
      canSubmit: boolean;
      preview: BulkCampaignEligibilityPreview;
      retry: () => void;
    }
  | { state: "deferred"; canSubmit: true; appliesAt: "each_run" }
  | {
      state: "error";
      canSubmit: false;
      error: string;
      /** Server reason, e.g. `meta_rate_limited`. */
      code?: string;
      /** Epoch ms from the server's Retry-After. */
      retryAt?: number;
      retry: () => void;
    };

export type UseBulkCampaignRecipientEligibilityPreviewInput = {
  workspaceId: string;
  channel: "whatsapp";
  messageIntent: BulkCampaignEligibilityMessageIntent;
  audience?: BulkCampaignAudienceIntent;
  recipientPolicy: BulkCampaignRecipientPolicy;
  provenance: BulkCampaignProvenanceIntent;
  scenarioRevision?: string;
  recurring: boolean;
  observedPlanRevision?: string;
};

const SKIP_REASONS = [
  "ineligible",
  "marketing_opt_out",
  "recipient_limit",
  "prior_failure",
  "service_window",
  "unsubscribed",
  "recent_contact",
] as const satisfies readonly BulkCampaignSkipReason[];

const idleState = {
  state: "idle",
  canSubmit: true,
} as const satisfies Extract<
  BulkCampaignEligibilityPreviewState,
  { state: "idle" }
>;

const deferredState = {
  state: "deferred",
  canSubmit: true,
  appliesAt: "each_run",
} as const satisfies Extract<
  BulkCampaignEligibilityPreviewState,
  { state: "deferred" }
>;

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function audienceIdentityKey(
  audience: BulkCampaignAudienceIntent | undefined
): string {
  if (!audience) return "";
  switch (audience.kind) {
    case "inline":
      return audience.recipients
        .map(
          recipient =>
            recipient.phone || recipient.chatId || recipient.email || ""
        )
        .join(",");
    case "analytics_with_fill_up": {
      const params = new URLSearchParams();
      appendBulkAnalyticsAudienceFiltersToSearchParams(
        params,
        audience.analytics.filters
      );
      const fillUp = audience.fillUpRecipients
        .map(recipient => recipient.phone || "")
        .join(",");
      return `analytics:${params.toString()}|fill:${fillUp}`;
    }
    case "registered_users":
      return `registered_users:${(audience.selectedUserIds || []).join(",")}`;
    case "registered_business_phones":
      return `registered_business_phones:${(audience.selectedPhones || []).join(",")}`;
    case "telegram_subscribers":
      return `telegram_subscribers:${audience.sourceId}`;
    default: {
      const exhaustive: never = audience;
      return exhaustive;
    }
  }
}

function isGeneratedPreview(
  input: UseBulkCampaignRecipientEligibilityPreviewInput
): input is UseBulkCampaignRecipientEligibilityPreviewInput & {
  provenance: Extract<
    BulkCampaignProvenanceIntent,
    { kind: "scenario_run_now" }
  >;
  scenarioRevision: string;
} {
  return (
    input.provenance.kind === "scenario_run_now" &&
    Boolean(input.scenarioRevision?.trim())
  );
}

function shouldPreview(
  input: UseBulkCampaignRecipientEligibilityPreviewInput
): boolean {
  if (input.messageIntent.kind !== "whatsapp_template") return false;
  if (!input.messageIntent.templateName.trim()) return false;
  if (input.recurring) return false;
  if (isGeneratedPreview(input)) return true;
  if (!input.messageIntent.sourceId.trim()) return false;
  if (!input.audience) return false;
  return (
    input.audience.kind === "inline" ||
    input.audience.kind === "analytics_with_fill_up"
  );
}

function buildSemanticRequestKey(
  input: UseBulkCampaignRecipientEligibilityPreviewInput,
  audienceIdentity: string
): string | null {
  if (input.recurring) return null;
  if (!shouldPreview(input)) return null;
  const generated = isGeneratedPreview(input);
  return JSON.stringify({
    workspaceId: input.workspaceId,
    channel: input.channel,
    messageKind: input.messageIntent.kind,
    sourceId:
      input.messageIntent.kind === "whatsapp_template"
        ? input.messageIntent.sourceId
        : "",
    templateName:
      input.messageIntent.kind === "whatsapp_template"
        ? input.messageIntent.templateName
        : "",
    language:
      input.messageIntent.kind === "whatsapp_template"
        ? input.messageIntent.language
        : "",
    audienceKind: generated ? "generated" : input.audience?.kind || "",
    audienceIdentity: generated ? "" : audienceIdentity,
    policy: input.recipientPolicy.excludePriorFailedBulkSends,
    provenanceKind: input.provenance.kind,
    scenarioId:
      input.provenance.kind === "scenario_run_now"
        ? input.provenance.scenarioId
        : "",
    scenarioRevision: input.scenarioRevision || "",
    observedPlanRevision: input.observedPlanRevision || "",
  });
}

async function readPreviewPayload(
  response: Response,
  fallbackError: string
): Promise<unknown> {
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw readBulkCampaignResponseError(response, payload, fallbackError);
  }
  return response.json();
}

function parseSkippedByReason(
  payload: Record<string, unknown>
): Partial<Record<BulkCampaignSkipReason, number>> {
  const skippedByReason: Partial<Record<BulkCampaignSkipReason, number>> = {};
  const canonical = payload.skippedByReason;
  if (isRecord(canonical)) {
    for (const reason of SKIP_REASONS) {
      const count = nonNegativeInteger(canonical[reason]);
      if (count) skippedByReason[reason] = count;
    }
  }
  const legacy: Array<[BulkCampaignSkipReason, unknown]> = [
    ["ineligible", payload.skippedIneligible],
    ["marketing_opt_out", payload.skippedOptIn ?? payload.excludedOptIn],
    ["recipient_limit", payload.skippedRecipientLimit],
    ["prior_failure", payload.skippedPriorFailed],
    ["service_window", payload.skippedServiceWindow],
    ["unsubscribed", payload.skippedUnsubscribed],
  ];
  for (const [reason, value] of legacy) {
    const count = nonNegativeInteger(value);
    if (count && skippedByReason[reason] === undefined) {
      skippedByReason[reason] = count;
    }
  }
  return skippedByReason;
}

function parseEligibilityPreviewPayload(
  payload: unknown
): BulkCampaignEligibilityPreview | { state: "deferred" } {
  if (!isRecord(payload)) {
    throw new TypeError("Malformed recipient eligibility preview");
  }
  if (payload.state === "deferred") {
    return { state: "deferred" };
  }
  const skippedByReason = parseSkippedByReason(payload);
  const skippedTotal = Object.values(skippedByReason).reduce(
    (total, value) => total + (value || 0),
    0
  );
  const acceptedTotal =
    nonNegativeInteger(payload.acceptedTotal) ??
    nonNegativeInteger(payload.eligibleTotal);
  const requestedTotal =
    nonNegativeInteger(payload.requestedTotal) ??
    (acceptedTotal !== undefined ? acceptedTotal + skippedTotal : undefined);
  if (acceptedTotal === undefined || requestedTotal === undefined) {
    throw new TypeError("Malformed recipient eligibility preview");
  }
  const uniqueRequested =
    isRecord(payload.uniqueRecipients) &&
    nonNegativeInteger(payload.uniqueRecipients.requested) !== undefined
      ? nonNegativeInteger(payload.uniqueRecipients.requested)!
      : requestedTotal;
  const uniqueAccepted =
    isRecord(payload.uniqueRecipients) &&
    nonNegativeInteger(payload.uniqueRecipients.accepted) !== undefined
      ? nonNegativeInteger(payload.uniqueRecipients.accepted)!
      : acceptedTotal;
  const missingMarketingConsent =
    isRecord(payload.warnings) &&
    nonNegativeInteger(payload.warnings.missingMarketingConsent) !== undefined
      ? nonNegativeInteger(payload.warnings.missingMarketingConsent)!
      : (nonNegativeInteger(payload.marketingOptInWarningCount) ?? 0);
  const allExcluded =
    payload.allExcluded === true || (requestedTotal > 0 && acceptedTotal === 0);
  const evaluatedAt =
    typeof payload.evaluatedAt === "string" &&
    Number.isFinite(Date.parse(payload.evaluatedAt))
      ? payload.evaluatedAt
      : null;
  const readiness: BulkCampaignReadiness = isBulkCampaignReadiness(
    payload.readiness
  )
    ? payload.readiness
    : {
        state: "unavailable",
        checkedAt: evaluatedAt ?? new Date().toISOString(),
        remainingCapacity: null,
        reasons: [{ code: "meta_check_unavailable" }],
      };

  return {
    state: "ready",
    evaluatedAt,
    requestedTotal,
    acceptedTotal,
    uniqueRecipients: {
      requested: uniqueRequested,
      accepted: uniqueAccepted,
    },
    skippedByReason,
    warnings: { missingMarketingConsent },
    allExcluded,
    readiness,
  };
}

function analyticsPreviewUrl(
  input: UseBulkCampaignRecipientEligibilityPreviewInput,
  audience: Extract<
    BulkCampaignAudienceIntent,
    { kind: "analytics_with_fill_up" }
  >
): string {
  const params = new URLSearchParams();
  appendBulkAnalyticsAudienceFiltersToSearchParams(
    params,
    audience.analytics.filters
  );
  if (input.messageIntent.kind === "whatsapp_template") {
    params.set("sourceId", input.messageIntent.sourceId);
    params.set("templateName", input.messageIntent.templateName);
    params.set("language", input.messageIntent.language);
  }
  if (input.recipientPolicy.excludePriorFailedBulkSends) {
    params.set("excludePriorFailedBulkSends", "1");
  }
  return `/api/workspaces/${input.workspaceId}/analytics/bulk/audience-preview?${params.toString()}`;
}

async function fetchPreview(
  input: UseBulkCampaignRecipientEligibilityPreviewInput,
  signal?: AbortSignal
): Promise<BulkCampaignEligibilityPreview | { state: "deferred" }> {
  if (isGeneratedPreview(input)) {
    const response = await fetch(
      `/api/scenarios/${encodeURIComponent(input.provenance.scenarioId)}/bulk-recipient-eligibility`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: input.workspaceId,
          ...(input.observedPlanRevision
            ? { observedPlanRevision: input.observedPlanRevision }
            : {}),
        }),
        signal,
      }
    );
    return parseEligibilityPreviewPayload(
      await readPreviewPayload(
        response,
        "Failed to check recipient eligibility"
      )
    );
  }

  const audience = input.audience;
  if (!audience) {
    throw new Error("Failed to check recipient eligibility");
  }

  if (audience.kind === "analytics_with_fill_up") {
    const url = analyticsPreviewUrl(input, audience);
    const hasFillUp = audience.fillUpRecipients.length > 0;
    const response = await fetch(url, {
      method: hasFillUp ? "POST" : "GET",
      headers: hasFillUp ? { "Content-Type": "application/json" } : undefined,
      body: hasFillUp
        ? serializeBulkCampaignInlineRequest({
            fillUpRecipients: audience.fillUpRecipients,
          })
        : undefined,
      signal,
    });
    return parseEligibilityPreviewPayload(
      await readPreviewPayload(
        response,
        "Failed to check the combined Analytics audience"
      )
    );
  }

  if (audience.kind !== "inline") {
    throw new Error("Failed to check recipient eligibility");
  }

  const response = await fetch("/api/campaigns/recipient-eligibility", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: serializeBulkCampaignInlineRequest({
      workspaceId: input.workspaceId,
      channel: input.channel,
      messageIntent: input.messageIntent,
      audience,
      recipientPolicy: input.recipientPolicy,
      provenance: input.provenance,
      recipients: audience.recipients,
      excludePriorFailedBulkSends:
        input.recipientPolicy.excludePriorFailedBulkSends || undefined,
    }),
    signal,
  });
  return parseEligibilityPreviewPayload(
    await readPreviewPayload(response, "Failed to check recipient eligibility")
  );
}

export function useBulkCampaignRecipientEligibilityPreview(
  input: UseBulkCampaignRecipientEligibilityPreviewInput
): BulkCampaignEligibilityPreviewState {
  const {
    workspaceId,
    channel,
    messageIntent,
    audience,
    recipientPolicy,
    provenance,
    scenarioRevision,
    recurring,
    observedPlanRevision,
  } = input;
  const previewInput = useMemo(
    (): UseBulkCampaignRecipientEligibilityPreviewInput => ({
      workspaceId,
      channel,
      messageIntent,
      audience,
      recipientPolicy,
      provenance,
      scenarioRevision,
      recurring,
      observedPlanRevision,
    }),
    [
      workspaceId,
      channel,
      messageIntent,
      audience,
      recipientPolicy,
      provenance,
      scenarioRevision,
      recurring,
      observedPlanRevision,
    ]
  );
  // Callers rebuild the intent objects each render; join the phones only when
  // the audience itself changes.
  const audienceIdentity = useMemo(
    () => audienceIdentityKey(audience),
    [audience]
  );
  const requestKey = useMemo(
    () => buildSemanticRequestKey(previewInput, audienceIdentity),
    [previewInput, audienceIdentity]
  );
  const { cache } = useSWRConfig();
  // Re-check only on a new key, Refresh or the contact deadline below. A
  // check can list the whole WhatsApp template catalog, which Meta throttles,
  // and bulk-send checks again at admission.
  const { data, error, isValidating, mutate } = useSWR(
    requestKey,
    (_key: string) => fetchPreview(previewInput),
    bulkCampaignCheckSWROptions(
      requestKey ? cache.get(requestKey)?.error : undefined
    )
  );
  const retry = useCallback(() => {
    void mutate().catch(() => undefined);
  }, [mutate]);
  const lastAutomaticCheck = useRef<{
    requestKey: string | null;
    deadline: number | null;
  }>({ requestKey: null, deadline: null });

  useEffect(() => {
    if (lastAutomaticCheck.current.requestKey !== requestKey) {
      lastAutomaticCheck.current = { requestKey, deadline: null };
    }
    if (
      !requestKey ||
      isValidating ||
      error ||
      data?.state !== "ready" ||
      data.readiness.state !== "blocked"
    )
      return;

    const deadlines = data.readiness.reasons.flatMap(reason => {
      if (reason.code !== "contact_frequency_limit" || !reason.nextEligibleAt)
        return [];
      const value = Date.parse(reason.nextEligibleAt);
      return Number.isFinite(value) ? [value] : [];
    });
    if (!deadlines.length) return;
    const deadline = Math.max(...deadlines);
    // A stale response or a browser clock ahead of the server must not cause a
    // request loop. The refresh button remains available.
    if (
      lastAutomaticCheck.current.deadline === deadline ||
      (deadline <= Date.now() && lastAutomaticCheck.current.deadline !== null)
    )
      return;

    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        if (Date.now() < deadline) {
          schedule();
          return;
        }
        lastAutomaticCheck.current = { requestKey, deadline };
        void mutate().catch(() => undefined);
      }, Math.min(2_147_483_647, Math.max(0, deadline - Date.now())));
    };
    schedule();
    return () => clearTimeout(timer);
  }, [requestKey, data, error, isValidating, mutate]);

  if (recurring && recipientPolicy.excludePriorFailedBulkSends) {
    return deferredState;
  }
  if (!requestKey) {
    return idleState;
  }
  // Cached readiness is not authority while a newer check is pending or failed.
  if (isValidating) return { state: "loading", canSubmit: false, retry };
  if (error) {
    const requestError =
      error instanceof BulkCampaignRequestError ? error : null;
    return {
      state: "error",
      canSubmit: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to check recipient eligibility",
      ...(requestError?.code ? { code: requestError.code } : {}),
      ...(requestError?.retryAt ? { retryAt: requestError.retryAt } : {}),
      retry,
    };
  }
  if (data?.state === "deferred") {
    return deferredState;
  }
  if (data?.state === "ready") {
    return {
      state: "ready",
      canSubmit: !data.allExcluded && data.readiness.state === "ready",
      preview: data,
      retry,
    };
  }
  return { state: "loading", canSubmit: false, retry };
}
