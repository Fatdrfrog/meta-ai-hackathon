import { getWorkspaceEmailProviderRow } from "@/lib/email/provider-config";
import {
  normalizeEmailUnsubscribeAddress,
  recordEmailUnsubscribe,
} from "@/lib/email/email-unsubscribes";
import {
  LEGACY_POSTMARK_CAMPAIGN_MESSAGE_ID_METADATA_KEY,
  POSTMARK_CAMPAIGN_MESSAGE_ID_METADATA_KEY,
  type PostmarkOutboundPayload,
} from "@/lib/postmark";
import { createServerLogger } from "@/lib/observability/server-logs";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { verifyPostmarkWebhookToken } from "@/lib/webhook-auth";
import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const outboundWebhookLogger = createServerLogger("email.outbound.webhook");

type CampaignMessageRow = {
  id: string;
  campaign_id: string;
  open_count?: number | null;
  click_count?: number | null;
};

function toIsoDate(value: unknown): string {
  const text = String(value || "").trim();
  if (!text) return new Date().toISOString();
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
}

function buildEventHash(payload: PostmarkOutboundPayload): string {
  const messageId = String(payload.MessageID || "");
  const recordType = String(payload.RecordType || "");
  const eventTime = toIsoDate(
    payload.DeliveredAt || payload.BouncedAt || payload.ReceivedAt
  );
  const raw = JSON.stringify(payload || {});
  return createHash("sha256")
    .update(`${messageId}:${recordType}:${eventTime}:${raw}`)
    .digest("hex");
}

function getMetadataString(
  payload: PostmarkOutboundPayload,
  key: string
): string {
  const metadata = payload.Metadata;
  if (!metadata || typeof metadata !== "object") return "";
  const value = metadata[key];
  return typeof value === "string" ? value.trim() : "";
}

function getCampaignCorrelationMessageId(
  payload: PostmarkOutboundPayload
): string {
  return (
    getMetadataString(payload, POSTMARK_CAMPAIGN_MESSAGE_ID_METADATA_KEY) ||
    getMetadataString(payload, LEGACY_POSTMARK_CAMPAIGN_MESSAGE_ID_METADATA_KEY)
  );
}

function getOutboundRecipientEmail(payload: PostmarkOutboundPayload): string {
  return normalizeEmailUnsubscribeAddress(
    String(payload.Recipient || payload.OriginalRecipient || "")
  );
}

function formatSupabaseLookupError(
  operation: string,
  error: { message?: string } | null | undefined
): Error {
  const message = String(error?.message || "Unknown database error");
  return new Error(`${operation}: ${message}`);
}

async function findCampaignMessageForOutboundPayload(
  payload: PostmarkOutboundPayload
): Promise<CampaignMessageRow | null> {
  const messageId = String(payload.MessageID || "").trim();
  const { data: campaignMessage, error: campaignMessageError } =
    await supabaseAdmin
      .from("campaign_messages")
      .select("id, campaign_id, open_count, click_count")
      .eq("message_id", messageId)
      .eq("channel", "email")
      .maybeSingle();

  if (campaignMessageError) {
    throw formatSupabaseLookupError(
      "Campaign message lookup by Postmark message id failed",
      campaignMessageError
    );
  }

  if (campaignMessage) {
    return campaignMessage as CampaignMessageRow;
  }

  const metadataMessageId = getCampaignCorrelationMessageId(payload);
  if (!metadataMessageId || metadataMessageId === messageId) {
    return null;
  }

  const {
    data: correlatedCampaignMessage,
    error: correlatedCampaignMessageError,
  } = await supabaseAdmin
    .from("campaign_messages")
    .select("id, campaign_id, open_count, click_count")
    .eq("message_id", metadataMessageId)
    .eq("channel", "email")
    .maybeSingle();

  if (correlatedCampaignMessageError) {
    throw formatSupabaseLookupError(
      "Campaign message lookup by metadata correlation id failed",
      correlatedCampaignMessageError
    );
  }

  return (correlatedCampaignMessage as CampaignMessageRow | null) || null;
}

async function applyOutboundEvent(params: {
  payload: PostmarkOutboundPayload;
  campaignMessage: CampaignMessageRow;
}) {
  const recordType = String(params.payload.RecordType || "").toLowerCase();
  const nowIso = new Date().toISOString();

  const patch: Record<string, unknown> = {
    updated_at: nowIso,
  };
  const messageId = String(params.payload.MessageID || "").trim();
  if (messageId) {
    patch.message_id = messageId;
  }

  if (recordType === "delivery") {
    patch.status = "delivered";
    patch.delivered_at = toIsoDate(
      params.payload.DeliveredAt || params.payload.ReceivedAt
    );
  } else if (recordType === "open") {
    patch.status = "opened";
    patch.opened_at = toIsoDate(params.payload.ReceivedAt);
    patch.open_count = (params.campaignMessage.open_count || 0) + 1;
  } else if (recordType === "click") {
    patch.status = "clicked";
    patch.clicked_at = toIsoDate(params.payload.ReceivedAt);
    patch.click_count = (params.campaignMessage.click_count || 0) + 1;
  } else if (recordType === "bounce") {
    patch.status = "bounced";
    patch.bounced_at = toIsoDate(
      params.payload.BouncedAt || params.payload.ReceivedAt
    );
    patch.failure_reason = String(params.payload.Details || "Bounce");
  } else if (recordType === "subscriptionchange") {
    patch.status = "unsubscribed";
    patch.unsubscribed_at = toIsoDate(params.payload.ReceivedAt);
  } else {
    return;
  }

  await supabaseAdmin
    .from("campaign_messages")
    .update(patch)
    .eq("id", params.campaignMessage.id);
}

export async function POST(req: NextRequest) {
  let payload: PostmarkOutboundPayload;
  try {
    payload = (await req.json()) as PostmarkOutboundPayload;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload" },
      { status: 400 }
    );
  }

  const messageId = String(payload.MessageID || "").trim();
  if (!messageId) {
    return NextResponse.json(
      { ok: true, ignored: true, reason: "missing_message_id" },
      { status: 200 }
    );
  }

  let campaignMessage: CampaignMessageRow | null;
  try {
    campaignMessage = await findCampaignMessageForOutboundPayload(payload);
  } catch (error) {
    outboundWebhookLogger.error(
      "Failed to look up campaign message for outbound webhook",
      error,
      { messageId }
    );
    return NextResponse.json(
      { ok: false, error: "Failed to look up campaign message" },
      { status: 500 }
    );
  }

  if (!campaignMessage) {
    return NextResponse.json(
      { ok: true, ignored: true, reason: "campaign_message_not_found" },
      { status: 200 }
    );
  }

  const { data: campaign, error: campaignError } = await supabaseAdmin
    .from("campaign_history")
    .select("workspace_id")
    .eq("id", campaignMessage.campaign_id)
    .maybeSingle();

  if (campaignError) {
    outboundWebhookLogger.error(
      "Failed to look up campaign for outbound webhook",
      formatSupabaseLookupError("Campaign lookup failed", campaignError),
      {
        campaignId: campaignMessage.campaign_id,
        messageId,
      }
    );
    return NextResponse.json(
      { ok: false, error: "Failed to look up campaign" },
      { status: 500 }
    );
  }

  if (!campaign?.workspace_id) {
    return NextResponse.json(
      { ok: true, ignored: true, reason: "campaign_not_found" },
      { status: 200 }
    );
  }

  const provider = await getWorkspaceEmailProviderRow(campaign.workspace_id);
  if (!provider) {
    return NextResponse.json(
      { ok: false, error: "Workspace email provider not configured" },
      { status: 400 }
    );
  }

  const expectedToken = String(provider.webhook_token || "").trim();
  if (!expectedToken || !verifyPostmarkWebhookToken(req, expectedToken)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const eventHash = buildEventHash(payload);
  const occurredAt = toIsoDate(
    payload.DeliveredAt || payload.BouncedAt || payload.ReceivedAt
  );

  const eventInsert = await supabaseAdmin
    .from("campaign_message_events")
    .insert({
      campaign_message_id: campaignMessage.id,
      event_type: String(payload.RecordType || "unknown"),
      event_hash: eventHash,
      payload,
      occurred_at: occurredAt,
    });

  if (
    eventInsert.error &&
    !String(eventInsert.error.message || "")
      .toLowerCase()
      .includes("duplicate")
  ) {
    return NextResponse.json(
      { error: eventInsert.error.message },
      { status: 500 }
    );
  }

  if (!eventInsert.error) {
    await applyOutboundEvent({
      payload,
      campaignMessage: campaignMessage as CampaignMessageRow,
    });

    if (
      String(payload.RecordType || "").toLowerCase() === "subscriptionchange"
    ) {
      const unsubscribeResult = await recordEmailUnsubscribe({
        supabase: supabaseAdmin,
        workspaceId: campaign.workspace_id,
        email: getOutboundRecipientEmail(payload),
        campaignId: campaignMessage.campaign_id,
        source: "postmark_subscription_change",
        unsubscribedAt: occurredAt,
      });
      if (!unsubscribeResult.ok) {
        outboundWebhookLogger.error(
          "Failed to store email unsubscribe for outbound webhook",
          new Error(unsubscribeResult.errorMessage || "Unknown database error"),
          {
            campaignId: campaignMessage.campaign_id,
            messageId,
          }
        );
      }
    }
  }

  return NextResponse.json({
    ok: true,
    campaignId: campaignMessage.campaign_id,
    duplicate: Boolean(eventInsert.error),
  });
}
