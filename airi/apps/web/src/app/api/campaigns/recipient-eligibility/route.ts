import {
  MAX_BULK_CAMPAIGN_RECIPIENTS,
  MAX_INLINE_BULK_CAMPAIGN_RECIPIENTS,
  BulkCampaignRecipientSchema,
  type BulkCampaignRecipient,
} from "@/lib/campaign/bulk-campaign-contracts";
import { bulkCampaignEligibilityErrorResponse } from "@/lib/campaign/bulk-campaign-eligibility-response";
import {
  preflightBulkCampaignWhatsAppTemplate,
  resolveBulkCampaignRecipientEligibility,
  resolveBulkCampaignWhatsAppPlan,
} from "@/lib/campaign/bulk-campaign-recipient-eligibility";
import { emitBulkCampaignPolicyEvent } from "@/lib/campaign/bulk-campaign-observability";
import { verifyBulkCampaignProvenanceCapability } from "@/lib/campaign/bulk-campaign-provenance";
import { canonicalizeBulkCampaignRecipientIdentity } from "@/lib/campaign/bulk-campaign-safety";
import { readCompanyBulkRecipientAllowance } from "@/lib/limits/company-limits";
import { logger } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";

const RecipientEligibilityRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  channel: z.literal("whatsapp"),
  messageIntent: z
    .object({
      kind: z.literal("whatsapp_template"),
      sourceId: z.string().trim().min(1),
      templateName: z.string().trim().min(1),
      language: z.string().trim().min(1),
    })
    .strict(),
  templateCategory: z
    .enum(["MARKETING", "UTILITY", "AUTHENTICATION"])
    .optional()
    .nullable(),
  recipients: z
    .array(BulkCampaignRecipientSchema)
    .max(MAX_INLINE_BULK_CAMPAIGN_RECIPIENTS)
    .default([]),
  excludePriorFailedBulkSends: z.boolean().optional(),
});

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

function compatibilityPreviewResponse(
  resolution: Awaited<
    ReturnType<typeof resolveBulkCampaignRecipientEligibility>
  >
) {
  const { preview, plan } = resolution;
  return {
    ...preview,
    eligibleTotal: preview.acceptedTotal,
    skippedOptIn: preview.skippedByReason.marketing_opt_out || 0,
    skippedPriorFailed: preview.skippedByReason.prior_failure || 0,
    marketingOptInWarningCount: preview.warnings.missingMarketingConsent,
    recipientLimit: {
      maxRecipients: plan.recipientLimit.maxRecipients,
      source: plan.recipientLimit.source,
    },
  };
}

export async function POST(request: Request) {
  let workspaceId: string | null = null;
  let parsedPolicy = {
    version: 1 as const,
    excludePriorFailedBulkSends: false,
  };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    const parsed = RecipientEligibilityRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid recipient eligibility request" },
        { status: 400 }
      );
    }
    workspaceId = parsed.data.workspaceId;
    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    parsedPolicy = {
      version: 1 as const,
      excludePriorFailedBulkSends: Boolean(
        parsed.data.excludePriorFailedBulkSends
      ),
    };
    const [provenanceCapability, bulkRecipientAllowance] = await Promise.all([
      verifyBulkCampaignProvenanceCapability({
        workspaceId,
        intent: { kind: "ad_hoc" },
        channel: "whatsapp",
        messageIntent: parsed.data.messageIntent,
      }),
      readCompanyBulkRecipientAllowance(supabaseAdmin, workspaceId),
    ]);
    const resolution = await resolveBulkCampaignRecipientEligibility(
      {
        workspaceId,
        channel: "whatsapp",
        messageIntent: parsed.data.messageIntent,
        audience: { kind: "inline", recipients: parsed.data.recipients },
        recipientPolicy: parsedPolicy,
        provenanceCapability,
        // With nothing left the plan blocks Send; the preview counts the list.
        recipientAllowance: bulkRecipientAllowance.remaining || null,
        ...(parsed.data.templateCategory
          ? {
              compatibilityTemplateCategoryHint: parsed.data.templateCategory,
            }
          : {}),
      },
      {
        resolveAudience: async () => ({
          candidates: parsed.data.recipients.map((recipient, index) => ({
            stableId: `inline:${index}`,
            recipient,
            value: recipient,
          })),
          completeness: {
            complete: true,
            uniqueRecipients: uniqueRecipientCount(parsed.data.recipients),
            dispatchItems: parsed.data.recipients.length,
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

    return NextResponse.json(compatibilityPreviewResponse(resolution));
  } catch (error) {
    return bulkCampaignEligibilityErrorResponse(error, {
      logger,
      workspaceId,
      policy: parsedPolicy,
    });
  }
}
