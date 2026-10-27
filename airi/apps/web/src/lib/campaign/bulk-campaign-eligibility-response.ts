import "server-only";

import type { BulkCampaignRecipientPolicy } from "@icecore/scenario-contracts";
import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";
import { NextResponse } from "next/server";

import { WhatsAppTemplateCatalogError } from "@/lib/whatsapp/templates/catalog-contracts";

import { emitBulkCampaignPolicyEvent } from "./bulk-campaign-observability";
import {
  BulkCampaignEligibilityError,
  bulkCampaignEligibilityErrorStatus,
  bulkCampaignEligibilityRetryAfterSeconds,
} from "./bulk-campaign-recipient-eligibility";
import { BulkRecipientPolicyError } from "./bulk-recipient-policy";

type BulkCampaignEligibilityLogger = {
  info(message: string, context?: Record<string, unknown>): unknown;
  warn(message: string, context?: Record<string, unknown>): unknown;
};

function graphCodeOf(error: unknown): number | undefined {
  return error instanceof MetaGraphRequestError
    ? error.metaError?.code
    : undefined;
}

function catalogErrorOf(
  error: unknown
): WhatsAppTemplateCatalogError | undefined {
  if (error instanceof WhatsAppTemplateCatalogError) return error;
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof WhatsAppTemplateCatalogError ? cause : undefined;
}

function eligibilityFailureCode(error: unknown): string {
  return error instanceof BulkCampaignEligibilityError ||
    error instanceof BulkRecipientPolicyError
    ? error.code
    : "eligibility_lookup_failed";
}

function eligibilityFailureRetryAfterSeconds(error: unknown): number | null {
  return error instanceof BulkCampaignEligibilityError ||
    error instanceof BulkRecipientPolicyError
    ? bulkCampaignEligibilityRetryAfterSeconds(error)
    : null;
}

/**
 * Logs the real exception behind a failed eligibility check or send. The
 * policy event and the response only carry the code. A template catalog
 * failure adds its own code, Meta's code and when it can be retried; none
 * of them carry credentials.
 */
export function logBulkCampaignEligibilityFailure(
  logger: Pick<BulkCampaignEligibilityLogger, "warn">,
  error: unknown,
  workspaceId: string | null
): void {
  const cause = error instanceof Error ? error.cause : undefined;
  const catalogError = catalogErrorOf(error);
  logger.warn("bulk_campaign.eligibility_failed", {
    workspaceId,
    code: eligibilityFailureCode(error),
    errorName: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    causeName: cause instanceof Error ? cause.name : undefined,
    causeMessage: cause instanceof Error ? cause.message : undefined,
    graphCode: graphCodeOf(cause) ?? graphCodeOf(error),
    ...(catalogError
      ? {
          catalogCode: catalogError.code,
          providerCode: catalogError.providerCode,
          retryAt: catalogError.retryAt,
        }
      : {}),
    retryAfterSeconds: eligibilityFailureRetryAfterSeconds(error) ?? undefined,
  });
}

/**
 * The blocked response for a failed eligibility preview. It logs the real
 * exception, keeps the existing `{ state: "blocked", error: { code } }` body
 * and tells the client when a Meta rate limit is worth retrying.
 */
export function bulkCampaignEligibilityErrorResponse(
  error: unknown,
  context: {
    logger: BulkCampaignEligibilityLogger;
    workspaceId: string | null;
    policy: BulkCampaignRecipientPolicy;
  }
): NextResponse {
  const code = eligibilityFailureCode(error);
  logBulkCampaignEligibilityFailure(context.logger, error, context.workspaceId);
  if (context.workspaceId) {
    emitBulkCampaignPolicyEvent(context.logger, {
      workspaceId: context.workspaceId,
      channel: "whatsapp",
      messageKind: "template",
      executionSource: "ad_hoc",
      itemCounts: { requested: 0, accepted: 0, queued: 0 },
      uniqueRecipientCounts: { requested: 0, accepted: 0, queued: 0 },
      skippedByReason: {},
      warnings: { missingMarketingConsent: 0 },
      disposition: "blocked",
      lifecycleStatus: null,
      planLimit: { source: "unavailable", value: null },
      policy: context.policy,
      errorCode: code,
      idempotentReplay: false,
    });
  }
  const retryAfterSeconds = eligibilityFailureRetryAfterSeconds(error);
  return NextResponse.json(
    {
      state: "blocked",
      error: { code },
      ...(retryAfterSeconds === null ? {} : { retryAfterSeconds }),
    },
    {
      status: bulkCampaignEligibilityErrorStatus(code),
      ...(retryAfterSeconds === null
        ? {}
        : { headers: { "Retry-After": String(retryAfterSeconds) } }),
    }
  );
}
