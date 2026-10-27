import {
  BulkAnalyticsAudienceUnavailableError,
  parseBulkAnalyticsAudienceFiltersFromSearchParams,
  resolveBulkAnalyticsAudience,
} from "@/lib/analytics/bulk-analytics-audience";
import {
  MAX_BULK_CAMPAIGN_RECIPIENTS,
  MAX_INLINE_BULK_CAMPAIGN_RECIPIENTS,
  BulkCampaignRecipientSchema,
  type BulkCampaignRecipient,
} from "@/lib/campaign/bulk-campaign-contracts";
import { bulkCampaignEligibilityErrorResponse } from "@/lib/campaign/bulk-campaign-eligibility-response";
import { emitBulkCampaignPolicyEvent } from "@/lib/campaign/bulk-campaign-observability";
import {
  preflightBulkCampaignWhatsAppTemplate,
  resolveBulkCampaignRecipientEligibility,
  resolveBulkCampaignWhatsAppPlan,
} from "@/lib/campaign/bulk-campaign-recipient-eligibility";
import { verifyBulkCampaignProvenanceCapability } from "@/lib/campaign/bulk-campaign-provenance";
import { canonicalizeBulkCampaignRecipientIdentity } from "@/lib/campaign/bulk-campaign-safety";
import { mergeCampaignRecipientsWithFillUp } from "@/lib/campaign/campaign-recipient-fill-up";
import { readCompanyBulkRecipientAllowance } from "@/lib/limits/company-limits";
import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = Promise<{ workspaceId: string }>;

const AnalyticsFillUpPreviewRequestSchema = z.object({
  fillUpRecipients: z
    .array(BulkCampaignRecipientSchema)
    .max(MAX_INLINE_BULK_CAMPAIGN_RECIPIENTS)
    .default([]),
});

const AnalyticsMessageIntentSchema = z.object({
  sourceId: z.string().trim().min(1),
  templateName: z.string().trim().min(1),
  language: z.string().trim().min(1),
  templateCategory: z
    .enum(["MARKETING", "UTILITY", "AUTHENTICATION"])
    .optional()
    .nullable(),
});

function parseMessageIntent(searchParams: URLSearchParams) {
  return AnalyticsMessageIntentSchema.safeParse({
    sourceId: searchParams.get("sourceId"),
    templateName: searchParams.get("templateName"),
    language: searchParams.get("language"),
    templateCategory: searchParams.get("templateCategory"),
  });
}

function parseBooleanSearchParam(value: string | null): boolean {
  return ["1", "true", "yes", "on"].includes(
    String(value || "")
      .trim()
      .toLowerCase()
  );
}

function uniqueRecipientCount(recipients: BulkCampaignRecipient[]): number {
  return new Set(
    recipients.map(recipient =>
      canonicalizeBulkCampaignRecipientIdentity({
        channel: "whatsapp",
        recipient,
      })
    )
  ).size;
}

async function previewAudience(
  request: NextRequest,
  { params }: { params: Params },
  fillUpRecipients: BulkCampaignRecipient[]
) {
  let workspaceId: string | null = null;
  let parsedPolicy = {
    version: 1 as const,
    excludePriorFailedBulkSends: false,
  };
  try {
    workspaceId = (await params).workspaceId;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;

    const searchParams = request.nextUrl.searchParams;
    parsedPolicy = {
      version: 1,
      excludePriorFailedBulkSends: parseBooleanSearchParam(
        searchParams.get("excludePriorFailedBulkSends")
      ),
    };
    const parsedIntent = parseMessageIntent(searchParams);
    if (!parsedIntent.success) {
      return NextResponse.json(
        { error: "Invalid Analytics preview message intent" },
        { status: 400 }
      );
    }

    await connectDB();
    const audience = await resolveBulkAnalyticsAudience({
      workspaceId,
      filters: parseBulkAnalyticsAudienceFiltersFromSearchParams(searchParams),
    });
    const mergedAudience =
      mergeCampaignRecipientsWithFillUp<BulkCampaignRecipient>({
        channel: "whatsapp",
        baseRecipients: audience.recipients,
        fillUpRecipients,
      });
    const messageIntent = {
      kind: "whatsapp_template" as const,
      sourceId: parsedIntent.data.sourceId,
      templateName: parsedIntent.data.templateName,
      language: parsedIntent.data.language,
    };
    const [provenanceCapability, bulkRecipientAllowance] = await Promise.all([
      verifyBulkCampaignProvenanceCapability({
        workspaceId,
        intent: { kind: "ad_hoc" },
        channel: "whatsapp",
        messageIntent,
      }),
      readCompanyBulkRecipientAllowance(supabaseAdmin, workspaceId),
    ]);
    const resolution = await resolveBulkCampaignRecipientEligibility(
      {
        workspaceId,
        channel: "whatsapp",
        messageIntent,
        audience: {
          kind: "analytics_with_fill_up",
          analytics: {
            filters:
              parseBulkAnalyticsAudienceFiltersFromSearchParams(searchParams),
          },
          fillUpRecipients,
        },
        recipientPolicy: parsedPolicy,
        provenanceCapability,
        // With nothing left the plan blocks Send; the preview counts the list.
        recipientAllowance: bulkRecipientAllowance.remaining || null,
        ...(parsedIntent.data.templateCategory
          ? {
              compatibilityTemplateCategoryHint:
                parsedIntent.data.templateCategory,
            }
          : {}),
      },
      {
        resolveAudience: async () => ({
          candidates: mergedAudience.recipients.map((recipient, index) => ({
            stableId: `analytics:${index}`,
            recipient,
            value: recipient,
          })),
          completeness: {
            complete: !audience.capped,
            uniqueRecipients: uniqueRecipientCount(mergedAudience.recipients),
            dispatchItems: mergedAudience.recipients.length,
            uniqueRecipientHardCap: MAX_BULK_CAMPAIGN_RECIPIENTS,
            dispatchItemHardCap: MAX_BULK_CAMPAIGN_RECIPIENTS,
          },
        }),
        preflight: preflightBulkCampaignWhatsAppTemplate,
        resolvePlan: ({ sourceId }) =>
          resolveBulkCampaignWhatsAppPlan({
            workspaceId: workspaceId!,
            sourceId,
          }),
        ...(parsedPolicy.excludePriorFailedBulkSends
          ? {
              priorFailure: {
                client: supabaseAdmin,
                secret: process.env.ENCRYPTION_SECRET || "",
              },
            }
          : {}),
      }
    );

    emitBulkCampaignPolicyEvent(logger, {
      workspaceId,
      channel: "whatsapp",
      messageKind: "template",
      executionSource: "ad_hoc",
      itemCounts: {
        requested: resolution.preview.requestedTotal,
        accepted: resolution.preview.acceptedTotal,
        queued: 0,
      },
      uniqueRecipientCounts: {
        requested: resolution.preview.uniqueRecipients.requested,
        accepted: resolution.preview.uniqueRecipients.accepted,
        queued: 0,
      },
      skippedByReason: resolution.preview.skippedByReason,
      warnings: resolution.preview.warnings,
      disposition: resolution.preview.allExcluded ? "no_op" : "queued",
      lifecycleStatus: resolution.preview.allExcluded ? "completed" : null,
      planLimit: {
        source: resolution.plan.recipientLimit.source,
        value: resolution.plan.recipientLimit.maxRecipients,
      },
      policy: parsedPolicy,
      idempotentReplay: false,
    });

    return NextResponse.json({
      available: true,
      total: audience.total,
      ...resolution.preview,
      eligibleTotal: resolution.preview.acceptedTotal,
      excludedOptIn: resolution.preview.skippedByReason.marketing_opt_out || 0,
      marketingOptInWarningCount:
        resolution.preview.warnings.missingMarketingConsent,
      skippedPriorFailed: resolution.preview.skippedByReason.prior_failure || 0,
      capped: audience.capped,
      recipientLimitTruncated:
        (resolution.preview.skippedByReason.recipient_limit || 0) > 0,
      maxRecipients: resolution.plan.recipientLimit.maxRecipients,
      recipientLimitSource: resolution.plan.recipientLimit.source,
    });
  } catch (error) {
    if (error instanceof BulkAnalyticsAudienceUnavailableError) {
      return NextResponse.json({
        available: false,
        reason: error.code,
        message: error.message,
        total: 0,
        eligibleTotal: 0,
        excludedOptIn: 0,
        marketingOptInWarningCount: 0,
        capped: false,
        maxRecipients: 0,
      });
    }
    return bulkCampaignEligibilityErrorResponse(error, {
      logger,
      workspaceId,
      policy: parsedPolicy,
    });
  }
}

export async function GET(request: NextRequest, context: { params: Params }) {
  return previewAudience(request, context, []);
}

export async function POST(request: NextRequest, context: { params: Params }) {
  const body = await request.json().catch(() => null);
  const parsed = AnalyticsFillUpPreviewRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid Analytics fill-up preview request" },
      { status: 400 }
    );
  }
  return previewAudience(request, context, parsed.data.fillUpRecipients);
}
