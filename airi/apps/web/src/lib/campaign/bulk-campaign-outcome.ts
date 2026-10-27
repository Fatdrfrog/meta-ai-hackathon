import {
  type BulkCampaignCommandResult,
  type BulkCampaignSkipReason,
  type BulkCampaignSuccessOutcome,
} from "@icecore/scenario-contracts";
import { z } from "zod";
import { isRecord } from "@icecore/shared/lib/value-utils";

const skipReasons = [
  "ineligible",
  "marketing_opt_out",
  "recipient_limit",
  "prior_failure",
  "service_window",
  "unsubscribed",
  "recent_contact",
] as const satisfies readonly BulkCampaignSkipReason[];

export type BulkCampaignEligibilityOutcomeStage = {
  skippedByReason: Partial<Record<BulkCampaignSkipReason, number>>;
  warnings: { missingMarketingConsent: number };
};

export type BulkCampaignAccumulatedEligibilityOutcome = {
  requestedTotal: number;
  acceptedTotal: number;
  uniqueRecipients: { requested: number; accepted: number };
  skippedByReason: Partial<Record<BulkCampaignSkipReason, number>>;
  warnings: { missingMarketingConsent: number };
  allExcluded: boolean;
};

const nonNegativeInteger = z.number().int().nonnegative();
const boundedReplayCount = nonNegativeInteger.max(50_000);
const replayFingerprint = z.string().regex(/^[a-f0-9]{64}$/);

const ReplayBatchPlanSchema = z.object({
  batchSize: z.number().int().positive().max(50_000),
  delayMs: z.number().int().nonnegative().max(2_147_483_647),
  ratePerSecond: z.number().finite().min(0.000001).max(50_000),
  rateSource: z.string().trim().min(1).max(128),
  throughputLevel: z.string().trim().min(1).max(128).nullable().optional(),
  dailyWaveLimit: z.number().int().positive().max(50_000).optional(),
});

const ReplayRecipientLimitSchema = z.object({
  originalCount: boundedReplayCount,
  acceptedCount: boundedReplayCount,
  rawLimit: z.string().trim().min(1).max(128).nullable().optional(),
  source: z.enum([
    "live_meta",
    "cached_meta",
    "channel_default",
    "unavailable",
  ]),
  truncated: z.boolean(),
});

const ReplayAudienceOverlapSchema = z
  .object({
    kind: z.enum(["none", "high", "exact", "unknown"]).optional(),
    intersectionCount: boundedReplayCount,
    candidateCount: boundedReplayCount,
    ratio: z.number().finite().min(0).max(1),
  })
  .superRefine((value, context) => {
    const expectedRatio = value.intersectionCount / value.candidateCount;
    if (
      value.candidateCount <= 0 ||
      value.intersectionCount > value.candidateCount ||
      Math.abs(value.ratio - expectedRatio) > Number.EPSILON * 10 ||
      (value.kind === "unknown" &&
        (value.intersectionCount !== 0 || value.ratio !== 0)) ||
      (value.kind === "exact" &&
        value.intersectionCount !== value.candidateCount) ||
      (value.kind === "high" &&
        (value.intersectionCount < 10 || value.ratio < 0.8))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Bulk campaign replay overlap is invalid",
      });
    }
  });

const ReplayAudienceSchema = z.object({
  fingerprint: replayFingerprint,
  requestedTotal: boundedReplayCount,
  queuedTotal: boundedReplayCount,
  skippedOptIn: boundedReplayCount,
  overlap: ReplayAudienceOverlapSchema.optional(),
});

const ReplayAudienceConfirmationSchema = z.object({
  required: z.boolean(),
  confirmed: z.boolean(),
  fingerprint: replayFingerprint.optional(),
});

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `Bulk campaign ${field} must be a non-negative integer`
    );
  }
}

export function accumulateBulkCampaignEligibilityOutcome(input: {
  requestedTotal: number;
  acceptedTotal: number;
  uniqueRecipients: { requested: number; accepted: number };
  stages: readonly BulkCampaignEligibilityOutcomeStage[];
}): BulkCampaignAccumulatedEligibilityOutcome {
  assertNonNegativeInteger(input.requestedTotal, "requestedTotal");
  assertNonNegativeInteger(input.acceptedTotal, "acceptedTotal");
  assertNonNegativeInteger(
    input.uniqueRecipients.requested,
    "uniqueRecipients.requested"
  );
  assertNonNegativeInteger(
    input.uniqueRecipients.accepted,
    "uniqueRecipients.accepted"
  );
  if (
    input.acceptedTotal > input.requestedTotal ||
    input.uniqueRecipients.requested > input.requestedTotal ||
    input.uniqueRecipients.accepted > input.acceptedTotal ||
    input.uniqueRecipients.accepted > input.uniqueRecipients.requested
  ) {
    throw new TypeError("Bulk campaign uniqueRecipients totals are invalid");
  }

  const skippedByReason: Partial<Record<BulkCampaignSkipReason, number>> = {};
  let missingMarketingConsent = 0;
  for (const stage of input.stages) {
    assertNonNegativeInteger(
      stage.warnings.missingMarketingConsent,
      "warnings.missingMarketingConsent"
    );
    missingMarketingConsent += stage.warnings.missingMarketingConsent;
    for (const reason of skipReasons) {
      const count = stage.skippedByReason[reason] || 0;
      assertNonNegativeInteger(count, `skippedByReason.${reason}`);
      if (count > 0) {
        skippedByReason[reason] = (skippedByReason[reason] || 0) + count;
      }
    }
  }

  const skippedTotal = Object.values(skippedByReason).reduce(
    (total, value) => total + (value || 0),
    0
  );
  if (input.requestedTotal !== input.acceptedTotal + skippedTotal) {
    throw new TypeError(
      "Bulk campaign requestedTotal must equal acceptedTotal plus skipped recipients"
    );
  }

  return {
    requestedTotal: input.requestedTotal,
    acceptedTotal: input.acceptedTotal,
    uniqueRecipients: input.uniqueRecipients,
    skippedByReason,
    warnings: { missingMarketingConsent },
    allExcluded: input.requestedTotal > 0 && input.acceptedTotal === 0,
  };
}

const BulkCampaignSuccessOutcomeSchema = z
  .object({
    disposition: z.enum(["queued", "scheduled", "no_op"]),
    evaluatedAt: z.string().datetime({ offset: true }),
    lifecycleStatus: z.enum([
      "queued",
      "scheduled",
      "running",
      "completed",
      "failed",
      "expired",
      "cancelled",
    ]),
    requestedTotal: nonNegativeInteger,
    acceptedTotal: nonNegativeInteger,
    queuedTotal: nonNegativeInteger,
    uniqueRecipients: z.object({
      requested: nonNegativeInteger,
      accepted: nonNegativeInteger,
      queued: nonNegativeInteger,
    }),
    skippedByReason: z
      .object(
        Object.fromEntries(
          skipReasons.map(reason => [reason, nonNegativeInteger.optional()])
        ) as Record<
          BulkCampaignSkipReason,
          z.ZodOptional<typeof nonNegativeInteger>
        >
      )
      .strict(),
    warnings: z
      .object({ missingMarketingConsent: nonNegativeInteger })
      .strict(),
    campaignId: z.string().min(1).optional(),
    dispatchId: z.string().min(1).optional(),
    workflowId: z.string().min(1).optional(),
  })
  .strict();

function assertOutcomeInvariants(outcome: BulkCampaignSuccessOutcome): void {
  const skippedTotal = Object.values(outcome.skippedByReason).reduce(
    (total, value) => total + (value || 0),
    0
  );
  if (outcome.requestedTotal !== outcome.acceptedTotal + skippedTotal) {
    throw new TypeError(
      "Bulk campaign requestedTotal must equal acceptedTotal plus skipped recipients"
    );
  }
  if (outcome.queuedTotal > outcome.acceptedTotal) {
    throw new TypeError(
      "Bulk campaign queuedTotal cannot exceed acceptedTotal"
    );
  }
  if (
    outcome.uniqueRecipients.requested > outcome.requestedTotal ||
    outcome.uniqueRecipients.accepted > outcome.acceptedTotal ||
    outcome.uniqueRecipients.queued > outcome.queuedTotal ||
    outcome.uniqueRecipients.accepted > outcome.uniqueRecipients.requested ||
    outcome.uniqueRecipients.queued > outcome.uniqueRecipients.accepted
  ) {
    throw new TypeError("Bulk campaign uniqueRecipients totals are invalid");
  }
}

export function createBulkCampaignSuccessResult(
  outcome: BulkCampaignSuccessOutcome
): Extract<BulkCampaignCommandResult, { ok: true }> {
  const parsed = BulkCampaignSuccessOutcomeSchema.parse(outcome);
  assertOutcomeInvariants(parsed);
  return { ok: true, outcome: parsed };
}

export function createBulkCampaignErrorResult(input: {
  disposition: "blocked" | "failed";
  code: string;
  message: string;
  partialOutcome?: BulkCampaignSuccessOutcome;
}): Extract<BulkCampaignCommandResult, { ok: false }> {
  const code = input.code.trim();
  const message = input.message.trim();
  if (!code || !message) {
    throw new TypeError(
      "Bulk campaign command errors require code and message"
    );
  }
  return {
    ok: false,
    disposition: input.disposition,
    code,
    message,
    ...(input.partialOutcome
      ? {
          partialOutcome: createBulkCampaignSuccessResult(input.partialOutcome)
            .outcome,
        }
      : {}),
  };
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function optionalIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function legacySkippedReasons(
  payload: Record<string, unknown>
): Partial<Record<BulkCampaignSkipReason, number>> {
  const values: Array<[BulkCampaignSkipReason, unknown]> = [
    ["ineligible", payload.skippedIneligible],
    ["marketing_opt_out", payload.skippedOptIn],
    ["recipient_limit", payload.skippedRecipientLimit],
    ["prior_failure", payload.skippedPriorFailed],
    ["service_window", payload.skippedServiceWindow],
    ["unsubscribed", payload.skippedUnsubscribed],
  ];
  const skippedByReason = Object.fromEntries(
    values.flatMap(([reason, value]) => {
      const total = nonNegativeNumber(value);
      return total === undefined || total === 0 ? [] : [[reason, total]];
    })
  ) as Partial<Record<BulkCampaignSkipReason, number>>;
  const namedSkippedTotal = Object.values(skippedByReason).reduce(
    (total, value) => total + (value || 0),
    0
  );
  const genericSkippedTotal = nonNegativeNumber(payload.skippedRecipientCount);
  if (
    genericSkippedTotal !== undefined &&
    genericSkippedTotal > namedSkippedTotal
  ) {
    skippedByReason.ineligible =
      (skippedByReason.ineligible || 0) +
      genericSkippedTotal -
      namedSkippedTotal;
  }
  return skippedByReason;
}

function legacySuccessResult(
  payload: Record<string, unknown>
): BulkCampaignCommandResult {
  const disposition =
    payload.noOp === true
      ? "no_op"
      : payload.scheduled === true
        ? "scheduled"
        : payload.queued === true
          ? "queued"
          : null;
  if (!disposition) {
    throw new TypeError("Malformed successful bulk campaign response");
  }

  const skippedByReason = legacySkippedReasons(payload);
  const skippedTotal = Object.values(skippedByReason).reduce(
    (total, value) => total + (value || 0),
    0
  );
  const queuedTotal =
    nonNegativeNumber(payload.queuedTotal) ?? nonNegativeNumber(payload.total);
  if (queuedTotal === undefined) {
    throw new TypeError("Malformed successful bulk campaign response");
  }
  const acceptedTotal = nonNegativeNumber(payload.successful) ?? queuedTotal;
  const requestedTotal =
    nonNegativeNumber(payload.requestedTotal) ?? acceptedTotal + skippedTotal;
  const lifecycleStatus =
    payload.status === "queued" ||
    payload.status === "scheduled" ||
    payload.status === "running" ||
    payload.status === "completed" ||
    payload.status === "failed" ||
    payload.status === "expired" ||
    payload.status === "cancelled"
      ? payload.status
      : disposition === "no_op"
        ? "completed"
        : disposition;

  return createBulkCampaignSuccessResult({
    disposition,
    evaluatedAt:
      (typeof payload.evaluatedAt === "string" && payload.evaluatedAt) ||
      (typeof payload.requestedAt === "string" && payload.requestedAt) ||
      new Date().toISOString(),
    lifecycleStatus,
    requestedTotal,
    acceptedTotal,
    queuedTotal,
    uniqueRecipients: {
      requested: requestedTotal,
      accepted: acceptedTotal,
      queued: queuedTotal,
    },
    skippedByReason,
    warnings: {
      missingMarketingConsent:
        nonNegativeNumber(payload.marketingOptInWarningCount) ?? 0,
    },
    ...(optionalIdentifier(payload.campaignId)
      ? { campaignId: optionalIdentifier(payload.campaignId) }
      : {}),
    ...(optionalIdentifier(payload.dispatchId)
      ? { dispatchId: optionalIdentifier(payload.dispatchId) }
      : {}),
    ...(optionalIdentifier(payload.workflowId)
      ? { workflowId: optionalIdentifier(payload.workflowId) }
      : {}),
  });
}

export function parseBulkCampaignCommandResult(input: {
  payload: unknown;
  httpStatus: number;
}): BulkCampaignCommandResult {
  const payload = input.payload;
  if (input.httpStatus >= 200 && input.httpStatus < 300) {
    if (isRecord(payload) && payload.ok === true && "outcome" in payload) {
      return createBulkCampaignSuccessResult(
        payload.outcome as BulkCampaignSuccessOutcome
      );
    }
    if (!isRecord(payload)) {
      throw new TypeError("Malformed successful bulk campaign response");
    }
    return legacySuccessResult(payload);
  }

  const record = isRecord(payload) ? payload : {};
  const partialOutcome = record.partialOutcome;
  return createBulkCampaignErrorResult({
    disposition:
      record.disposition === "blocked" || record.disposition === "failed"
        ? record.disposition
        : input.httpStatus >= 400 && input.httpStatus < 500
          ? "blocked"
          : "failed",
    code:
      (typeof record.code === "string" && record.code) ||
      "bulk_campaign_request_failed",
    message:
      (typeof record.message === "string" && record.message) ||
      (typeof record.error === "string" && record.error) ||
      "Failed to send campaign",
    ...(partialOutcome && typeof partialOutcome === "object"
      ? { partialOutcome: partialOutcome as BulkCampaignSuccessOutcome }
      : {}),
  });
}

function legacyAliases(
  outcome: BulkCampaignSuccessOutcome
): Record<string, unknown> {
  const skippedRecipientCount = Object.values(outcome.skippedByReason).reduce(
    (total, value) => total + (value || 0),
    0
  );
  return {
    queued: outcome.disposition !== "no_op",
    scheduled: outcome.disposition === "scheduled",
    noOp: outcome.disposition === "no_op",
    status: outcome.lifecycleStatus,
    total: outcome.queuedTotal,
    requestedTotal: outcome.requestedTotal,
    successful: outcome.acceptedTotal,
    skippedRecipientCount,
    skippedIneligible: outcome.skippedByReason.ineligible || 0,
    skippedOptIn: outcome.skippedByReason.marketing_opt_out || 0,
    skippedRecipientLimit: outcome.skippedByReason.recipient_limit || 0,
    skippedPriorFailed: outcome.skippedByReason.prior_failure || 0,
    skippedServiceWindow: outcome.skippedByReason.service_window || 0,
    skippedUnsubscribed: outcome.skippedByReason.unsubscribed || 0,
    marketingOptInWarningCount: outcome.warnings.missingMarketingConsent,
    ...(outcome.campaignId ? { campaignId: outcome.campaignId } : {}),
    ...(outcome.dispatchId ? { dispatchId: outcome.dispatchId } : {}),
    ...(outcome.workflowId ? { workflowId: outcome.workflowId } : {}),
  };
}

export function serializeBulkCampaignCommandResult(
  result: BulkCampaignCommandResult
): Record<string, unknown> {
  if (result.ok) {
    return {
      ok: true,
      outcome: result.outcome,
      ...legacyAliases(result.outcome),
    };
  }

  return {
    ok: false,
    disposition: result.disposition,
    code: result.code,
    message: result.message,
    error: result.message,
    ...(result.partialOutcome
      ? {
          partialOutcome: result.partialOutcome,
          ...legacyAliases(result.partialOutcome),
        }
      : {}),
  };
}

const queuedReplayMessage =
  "Campaign queued in Temporal. Messages will be sent in the background. Check campaign history for delivery status.";
const scheduledReplayMessage =
  "Campaign scheduled in Temporal. Messages will be sent at the selected date.";

/**
 * Rebuild a persisted HTTP replay from the canonical result and an explicit
 * aggregate-only compatibility allowlist. Persisted response JSON is
 * untrusted: never spread it back into an HTTP response or idempotency cache.
 */
export function projectBulkCampaignReplayResponse(payload: unknown): {
  result: Extract<BulkCampaignCommandResult, { ok: true }>;
  responseBody: Record<string, unknown>;
} {
  if (!isRecord(payload)) {
    throw new TypeError("Malformed successful bulk campaign response");
  }
  if (
    !(payload.ok === true && "outcome" in payload) &&
    typeof payload.evaluatedAt !== "string" &&
    typeof payload.requestedAt !== "string"
  ) {
    throw new TypeError("Persisted bulk campaign replay timestamp is missing");
  }

  const result = parseBulkCampaignCommandResult({ payload, httpStatus: 200 });
  if (!result.ok) {
    throw new TypeError("Malformed successful bulk campaign response");
  }
  const responseBody = serializeBulkCampaignCommandResult(result);
  const outcome = result.outcome;
  const canCarryDispatchCompatibility =
    outcome.disposition === "queued" || outcome.disposition === "scheduled";

  if ("recipientLimit" in payload && payload.recipientLimit !== undefined) {
    const recipientLimit = ReplayRecipientLimitSchema.parse(
      payload.recipientLimit
    );
    const skippedByLimit = outcome.skippedByReason.recipient_limit || 0;
    const minimumOriginalCount = outcome.acceptedTotal + skippedByLimit;
    if (
      recipientLimit.acceptedCount !== outcome.acceptedTotal ||
      recipientLimit.originalCount < minimumOriginalCount ||
      recipientLimit.originalCount > outcome.requestedTotal ||
      recipientLimit.truncated !== skippedByLimit > 0
    ) {
      throw new TypeError(
        "Persisted bulk campaign recipient limit is inconsistent"
      );
    }
    responseBody.recipientLimit = recipientLimit;
  }

  if (!canCarryDispatchCompatibility) {
    return { result, responseBody };
  }

  if ("scheduledAt" in payload && payload.scheduledAt !== undefined) {
    if (outcome.disposition !== "scheduled") {
      throw new TypeError(
        "Persisted bulk campaign scheduledAt is inconsistent"
      );
    }
    const scheduledAt = z
      .string()
      .datetime({ offset: true })
      .parse(payload.scheduledAt);
    responseBody.scheduledAt = new Date(scheduledAt).toISOString();
  }

  if ("batchPlan" in payload && payload.batchPlan !== undefined) {
    responseBody.batchPlan = ReplayBatchPlanSchema.parse(payload.batchPlan);
  }
  if (
    "temporalDispatchStaging" in payload &&
    payload.temporalDispatchStaging !== undefined
  ) {
    responseBody.temporalDispatchStaging = z
      .enum(["inline", "gcs", "existing"])
      .parse(payload.temporalDispatchStaging);
  }

  let replayAudience: z.infer<typeof ReplayAudienceSchema> | undefined;
  if ("audience" in payload && payload.audience !== undefined) {
    replayAudience = ReplayAudienceSchema.parse(payload.audience);
    if (
      replayAudience.requestedTotal !== outcome.requestedTotal ||
      replayAudience.queuedTotal !== outcome.queuedTotal ||
      replayAudience.skippedOptIn !==
        (outcome.skippedByReason.marketing_opt_out || 0) ||
      (replayAudience.overlap !== undefined &&
        replayAudience.overlap.candidateCount !==
          outcome.uniqueRecipients.accepted)
    ) {
      throw new TypeError("Persisted bulk campaign audience is inconsistent");
    }
    responseBody.audience = replayAudience;
  }

  if (
    "audienceConfirmation" in payload &&
    payload.audienceConfirmation !== undefined
  ) {
    const confirmation = ReplayAudienceConfirmationSchema.parse(
      payload.audienceConfirmation
    );
    if (
      !replayAudience ||
      (confirmation.confirmed && !confirmation.required) ||
      (confirmation.confirmed && confirmation.fingerprint === undefined) ||
      (confirmation.fingerprint !== undefined &&
        confirmation.fingerprint !== replayAudience.fingerprint)
    ) {
      throw new TypeError(
        "Persisted bulk campaign audience confirmation is inconsistent"
      );
    }
    responseBody.audienceConfirmation = confirmation;
  }

  responseBody.message =
    outcome.disposition === "scheduled"
      ? scheduledReplayMessage
      : queuedReplayMessage;

  const hasScenarioActivated = "scenarioActivated" in payload;
  const hasScenarioStatus = "scenarioStatus" in payload;
  if (hasScenarioActivated || hasScenarioStatus) {
    if (
      payload.scenarioActivated !== true ||
      payload.scenarioStatus !== "active"
    ) {
      throw new TypeError(
        "Persisted bulk campaign scenario activation is inconsistent"
      );
    }
    responseBody.scenarioActivated = true;
    responseBody.scenarioStatus = "active";
  }

  return { result, responseBody };
}
