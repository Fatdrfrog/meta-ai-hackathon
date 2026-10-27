import { randomUUID } from "node:crypto";

import type { BulkCampaignDispatchItem } from "@icecore/temporal";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuthenticatedWorkspaceMembership } from "@/lib/auth/workspace-membership";
import {
  classifyBulkCampaignRetryProviderCircuit,
  parseBulkCampaignRetryDispatchItems,
} from "@/lib/campaign/bulk-campaign-retry";
import {
  resolveCampaignBatchPlan,
  resolveCampaignBatchPlanPreview,
} from "@/lib/campaign/campaign-batch-plan";
import { resolveMinimumBulkCampaignPlan } from "@/lib/campaign/bulk-campaign-recipient-eligibility";
import { resolveFreshWhatsAppSendContext } from "@/lib/whatsapp/send-context";
import type { BulkCampaignReadiness } from "@icecore/scenario-contracts";
import { prepareFailedCampaignRetry } from "@/lib/campaign/campaign-history-store";
import { isCampaignOperationUuid } from "@/lib/campaign/campaign-operation-route-utils";
import type {
  CampaignFailedOnlyRetryResponse,
  CampaignRetryContactCooldownResponse,
} from "@/lib/campaign/campaign-operations-contracts";
import { partitionRecentlyContactedRecipients } from "@/lib/campaign/customer-contact-policy";
import { filterKnownMarketingOptOutRecipients } from "@/lib/campaign/marketing-opt-in";
import {
  PreparedBulkCampaignQueueError,
  queuePreparedBulkCampaignDispatch,
} from "@/lib/campaign/queue-prepared-bulk-campaign-dispatch";
import { normalizeCampaignPhone } from "@/lib/campaign/campaign-recipient-utils";
import { logger } from "@/lib/logger";
import { ensureCompanyConversationCapacity } from "@/lib/limits/company-limits";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isWorkspaceManagerRole } from "@/lib/supabase/company-users";
import { isWorkspaceFeatureEnabled } from "@/lib/workspace-feature-flags";

const retryRequestSchema = z
  .object({
    workspaceId: z.string().uuid(),
    providerCircuitAcknowledged: z.boolean().optional(),
  })
  .strict();
const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "expired",
  "cancelled",
]);

type RouteContext = {
  params: Promise<{ campaignId: string }>;
};

function invalidRetrySnapshotResponse() {
  return NextResponse.json(
    {
      code: "invalid_retry_snapshot",
      error: "Campaign failed-recipient snapshots cannot be retried safely.",
    },
    { status: 409 }
  );
}

export async function POST(request: Request, context: RouteContext) {
  const { campaignId } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 }
    );
  }
  const parsedBody = retryRequestSchema.safeParse(body);
  if (!isCampaignOperationUuid(campaignId) || !parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid retry request." },
      { status: 400 }
    );
  }

  const { workspaceId, providerCircuitAcknowledged = false } = parsedBody.data;
  const authorization = await getAuthenticatedWorkspaceMembership(workspaceId);
  if ("error" in authorization) {
    return (
      authorization.error ??
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );
  }
  if (!isWorkspaceManagerRole(authorization.membership.role)) {
    return NextResponse.json(
      { error: "Only managers and admins can retry campaigns." },
      { status: 403 }
    );
  }

  try {
    const [preparation, companyCapacity] = await Promise.all([
      prepareFailedCampaignRetry({
        supabase: supabaseAdmin,
        workspaceId,
        campaignId,
      }),
      ensureCompanyConversationCapacity(supabaseAdmin, workspaceId),
    ]);
    if (!preparation) {
      return NextResponse.json(
        { code: "campaign_not_found", error: "Campaign was not found." },
        { status: 404 }
      );
    }
    if (!TERMINAL_STATUSES.has(preparation.source.status)) {
      return NextResponse.json(
        {
          code: "campaign_not_terminal",
          error: "Only terminal campaigns can be retried.",
        },
        { status: 409 }
      );
    }
    if (preparation.failedSnapshots.length === 0) {
      return NextResponse.json(
        {
          code: "no_failed_recipients",
          error: "This campaign has no failed recipients to retry.",
        },
        { status: 409 }
      );
    }

    let parsedItems: BulkCampaignDispatchItem[];
    let providerCircuit: ReturnType<
      typeof classifyBulkCampaignRetryProviderCircuit
    >;
    try {
      parsedItems = parseBulkCampaignRetryDispatchItems(
        preparation.failedSnapshots.map(row => ({
          row,
          expected: {
            workspaceId,
            campaignId,
            channel: preparation.source.channel,
          },
        }))
      );
      providerCircuit = classifyBulkCampaignRetryProviderCircuit({
        totalRecipients: preparation.source.totalRecipients,
        failedSnapshots: preparation.failedSnapshots,
        storedCircuit: preparation.source.providerCircuit,
      });
      if (
        providerCircuit.state === "closed" &&
        preparation.ancestorProviderCircuit
      ) {
        providerCircuit = preparation.ancestorProviderCircuit;
      }
    } catch {
      return invalidRetrySnapshotResponse();
    }

    if (
      parsedItems.some(
        item =>
          item.channel === "whatsapp" &&
          item.whatsappMessageType === "service_text"
      ) &&
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

    if (providerCircuit.state === "open" && !providerCircuitAcknowledged) {
      return NextResponse.json(
        {
          code: "provider_circuit_acknowledgement_required",
          error:
            "Confirm that the provider problem was repaired before retrying.",
          providerCircuit: {
            ...providerCircuit,
            requiresAcknowledgement: true,
          },
        },
        { status: 409 }
      );
    }

    const childCampaignId = randomUUID();
    const normalizedItems = parsedItems.map(
      item =>
        ({
          ...item,
          workspaceId,
          campaignId: childCampaignId,
          channel: preparation.source.channel,
          sentByUserId: authorization.user.id,
          executionSource: "ad_hoc",
          generatedRecipientMessageId: null,
        }) as BulkCampaignDispatchItem
    );
    const requestedTotal = normalizedItems.length;
    let dispatchItems = normalizedItems;
    let skippedOptIn = 0;

    const marketingRecipients = normalizedItems.flatMap(item =>
      item.channel === "whatsapp" &&
      item.whatsappMessageType !== "service_text" &&
      item.templateCategory === "MARKETING"
        ? [{ phone: item.recipient.phone }]
        : []
    );
    if (marketingRecipients.length > 0) {
      const consent = await filterKnownMarketingOptOutRecipients({
        workspaceId,
        recipients: marketingRecipients,
      });
      const eligiblePhones = new Set(
        consent.recipients.map(recipient =>
          normalizeCampaignPhone(recipient.phone || "")
        )
      );
      dispatchItems = normalizedItems.filter(
        item =>
          item.channel !== "whatsapp" ||
          item.whatsappMessageType === "service_text" ||
          item.templateCategory !== "MARKETING" ||
          eligiblePhones.has(normalizeCampaignPhone(item.recipient.phone))
      );
      skippedOptIn = normalizedItems.length - dispatchItems.length;
      if (dispatchItems.length === 0) {
        return NextResponse.json(
          {
            code: "retry_consent_changed",
            error:
              "No failed recipients remain after excluding explicit WhatsApp marketing opt-outs.",
          },
          { status: 409 }
        );
      }
    }

    // Recently contacted recipients are left out of the retry; only a
    // retry left with nobody is refused.
    let skippedRecentContact = 0;
    const contactRecipients = dispatchItems.flatMap(item =>
      item.channel === "whatsapp" &&
      (item.whatsappMessageType === "service_text" ||
        !item.templateCategory ||
        item.templateCategory === "MARKETING")
        ? [{ phone: item.recipient.phone || "", item }]
        : []
    );
    if (contactRecipients.length > 0) {
      const contacts = await partitionRecentlyContactedRecipients({
        workspaceId,
        recipients: contactRecipients,
      });
      if (contacts.recentlyContacted.length > 0) {
        const recentItems = new Set<BulkCampaignDispatchItem>(
          contacts.recentlyContacted.map(entry => entry.item)
        );
        if (recentItems.size === dispatchItems.length) {
          const response: CampaignRetryContactCooldownResponse = {
            code: "retry_contact_cooldown",
            error:
              "Every recipient is still in the local contact cooldown. No retry was queued.",
            cooldown: {
              blockedRecipientCount: recentItems.size,
              eligibleRecipientCount: 0,
              nextEligibleAt: contacts.nextEligibleAt,
            },
          };
          return NextResponse.json(response, { status: 409 });
        }
        dispatchItems = dispatchItems.filter(item => !recentItems.has(item));
        skippedRecentContact = recentItems.size;
      }
    }

    const templateSenders = new Map<
      string,
      Extract<BulkCampaignDispatchItem, { channel: "whatsapp" }>
    >();
    for (const item of dispatchItems) {
      if (
        item.channel === "whatsapp" &&
        item.whatsappMessageType !== "service_text"
      ) {
        templateSenders.set(
          JSON.stringify([item.sourceId || null, item.phoneNumberId]),
          item
        );
      }
    }
    let batchPlan;
    if (templateSenders.size > 0) {
      let readiness: BulkCampaignReadiness;
      try {
        const preview = await resolveMinimumBulkCampaignPlan({
          sourceIds: [...templateSenders.keys()],
          resolvePlan: async ({ sourceId: senderKey }) => {
            const item = templateSenders.get(senderKey)!;
            const sender = await resolveFreshWhatsAppSendContext({
              workspaceId,
              sourceId: item.sourceId,
            });
            if (
              !sender ||
              sender.workspaceId !== workspaceId ||
              (item.sourceId && sender.sourceId !== item.sourceId) ||
              sender.phoneNumberId !== item.phoneNumberId
            ) {
              throw new Error("Retry sender binding is unavailable");
            }
            return resolveCampaignBatchPlanPreview({
              channel: "whatsapp",
              wabaId: sender.wabaId,
              phoneNumberId: sender.phoneNumberId,
              accessToken: sender.accessToken,
              cachedMessagingLimit: sender.cachedMessagingLimit,
            });
          },
        });
        batchPlan = preview.batchPlan;
        readiness = preview.readiness!;
      } catch {
        readiness = {
          state: "unavailable",
          checkedAt: new Date().toISOString(),
          remainingCapacity: null,
          reasons: [{ code: "meta_check_unavailable" }],
        };
      }
      if (readiness.state !== "ready" || !batchPlan) {
        return NextResponse.json(
          {
            code:
              readiness.state === "blocked"
                ? "whatsapp_sending_blocked"
                : "whatsapp_sending_unavailable",
            error:
              readiness.state === "blocked"
                ? "Meta currently restricts WhatsApp sending. No retry was queued."
                : "WhatsApp sending readiness could not be verified. No retry was queued.",
            readiness,
          },
          { status: readiness.state === "blocked" ? 409 : 503 }
        );
      }
    } else {
      const firstWhatsAppItem = dispatchItems.find(
        item => item.channel === "whatsapp"
      );
      batchPlan = await resolveCampaignBatchPlan({
        channel: preparation.source.channel,
        phoneNumberId:
          firstWhatsAppItem?.channel === "whatsapp"
            ? firstWhatsAppItem.phoneNumberId
            : undefined,
      });
    }
    const queued = await queuePreparedBulkCampaignDispatch({
      storeClient: supabaseAdmin,
      fingerprintSecret: process.env.ENCRYPTION_SECRET || "",
      campaignId: childCampaignId,
      workspaceId,
      channel: preparation.source.channel,
      campaignName: preparation.source.name,
      templateName: preparation.source.templateName,
      templateLanguage: preparation.source.templateLanguage,
      messageText: preparation.source.messageText,
      sentBy: authorization.user.id,
      scenarioId: null,
      scenarioNodeId: null,
      executionSource: "ad_hoc",
      scheduledAt: null,
      batchPlan,
      items: dispatchItems,
      audienceSourceType: "failed_retry",
      requestedTotal,
      skippedOptIn,
      retryOfCampaignId: campaignId,
      retryKind: "failed_only",
      // Admission refuses a retry larger than the free recipients left.
      companyBulkCampaignLimit: companyCapacity.limit.bulkRecipientLimit,
      companySubscriptionType: companyCapacity.limit.subscriptionType,
      confirmAudience: true,
      providerCircuitAcknowledgement:
        providerCircuit.state === "open"
          ? { acknowledgedBy: authorization.user.id }
          : null,
    });

    const response: CampaignFailedOnlyRetryResponse = {
      queued: true,
      skippedRecentContact,
      scheduled: queued.status === "scheduled",
      total: queued.total,
      campaignId: queued.campaignId,
      dispatchId: queued.dispatchId,
      workflowId: queued.workflowId,
      status: queued.status,
      requestedAt: queued.requestedAt,
      dispatchExpiresAt: queued.dispatchExpiresAt,
      temporalDispatchStaging: queued.temporalDispatchStaging,
      idempotentReplay: queued.idempotentReplay,
      audience: queued.audience,
      audienceConfirmation: queued.audienceConfirmation,
      retry: {
        kind: "failed_only",
        ofCampaignId: campaignId,
        providerCircuit:
          providerCircuit.state === "open"
            ? {
                ...providerCircuit,
                acknowledged: true,
              }
            : {
                state: "closed",
                acknowledged: false,
              },
      },
    };
    return NextResponse.json(response, { status: 202 });
  } catch (error) {
    if (error instanceof PreparedBulkCampaignQueueError) {
      return NextResponse.json(error.body, { status: error.httpStatus });
    }
    logger.error("campaign.retry_queue_failed", error, {
      event: "campaign.retry_queue_failed",
      campaignId,
      workspaceId,
    });
    return NextResponse.json(
      { error: "Failed to retry campaign." },
      { status: 500 }
    );
  }
}
