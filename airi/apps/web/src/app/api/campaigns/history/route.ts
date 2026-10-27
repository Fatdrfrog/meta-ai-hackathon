import { getAuthenticatedWorkspaceMembership } from "@/lib/auth/workspace-membership";
import {
  getCampaignDispatchBatchAggregates,
  type CampaignDispatchAggregate,
} from "@/lib/campaign/campaign-history-store";
import {
  isCampaignOperationUuid,
  serializeCampaignHistoryOperation,
} from "@/lib/campaign/campaign-operation-route-utils";
import {
  attachWhatsAppCampaignReplyStats,
  type CampaignReplyStats,
} from "@/lib/campaign/campaign-reply-stats";
import { resolveWhatsAppCampaignCostStatus } from "@icecore/shared/constants/whatsapp-message-rates";
import { logger } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";

/**
 * Campaign History API
 * Track sent bulk campaigns across supported channels.
 */

type CampaignMessagePreviewRow = {
  campaign_id?: string | null;
  status?: string | null;
  error_code?: number | string | null;
  error_message?: string | null;
  failure_reason?: string | null;
  id?: string | null;
  message_id?: string | null;
  channel?: string | null;
  recipient?: string | null;
  phone?: string | null;
  provider?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
  opened_at?: string | null;
  clicked_at?: string | null;
  bounced_at?: string | null;
};

type SupabaseQueryError = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
};

function isMissingFailureReasonColumnError(
  error: SupabaseQueryError | null | undefined
): boolean {
  if (!error) return false;

  const text = [error.message, error.details, error.hint]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!text.includes("failure_reason")) return false;

  return (
    error.code === "PGRST204" ||
    /column .* does not exist/i.test(text) ||
    /schema cache/i.test(text)
  );
}

function normalizeFailureErrorCode(
  value: CampaignMessagePreviewRow["error_code"]
) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCampaignMessagePreview(row: CampaignMessagePreviewRow) {
  return {
    id: row.id || row.message_id || null,
    message_id: row.message_id || null,
    channel: row.channel || null,
    recipient: row.recipient || row.phone || null,
    phone: row.phone || null,
    provider: row.provider || null,
    status: row.status || null,
    error_code: normalizeFailureErrorCode(row.error_code),
    error_message: row.error_message || row.failure_reason || null,
    failure_reason: row.failure_reason || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    delivered_at: row.delivered_at || null,
    read_at: row.read_at || row.opened_at || null,
    clicked_at: row.clicked_at || null,
    bounced_at: row.bounced_at || null,
  };
}

function groupCampaignMessagePreviews(
  rows: CampaignMessagePreviewRow[]
): Map<string, ReturnType<typeof normalizeCampaignMessagePreview>[]> {
  const grouped = new Map<
    string,
    ReturnType<typeof normalizeCampaignMessagePreview>[]
  >();

  rows.forEach(row => {
    const campaignId =
      typeof row.campaign_id === "string" ? row.campaign_id : null;
    if (!campaignId) return;

    const messages = grouped.get(campaignId) || [];
    messages.push(normalizeCampaignMessagePreview(row));
    grouped.set(campaignId, messages);
  });

  return grouped;
}

type CampaignHistoryRow = {
  id?: string | null;
  name?: string | null;
  channel?: string | null;
  template_name?: string | null;
  template_language?: string | null;
  message_text?: string | null;
  total_recipients?: number | null;
  successful_sends?: number | null;
  failed_sends?: number | null;
  sent_at?: string | null;
  estimated_cost?: number | null;
  cost_coverage_started_at?: string | null;
  unknown_cost_count?: number | null;
  delivery_rate?: number | null;
  read_rate?: number | null;
  open_rate?: number | null;
  click_rate?: number | null;
  unsubscribe_rate?: number | null;
  bounce_rate?: number | null;
  dispatch_status?: string | null;
  requested_at?: string | null;
  scheduled_at?: string | null;
  dispatch_expires_at?: string | null;
  started_at?: string | null;
  progress_at?: string | null;
  finished_at?: string | null;
  cancelled_at?: string | null;
  expired_at?: string | null;
  processed_count?: number | null;
  accepted_count?: number | null;
  attempted_count?: number | null;
  not_attempted_count?: number | null;
  stop_reason?: string | null;
  provider_circuit_state?: string | null;
  provider_circuit_provider?: string | null;
  provider_circuit_code?: string | null;
  provider_circuit_opened_at?: string | null;
  retry_of_campaign_id?: string | null;
  retry_kind?: string | null;
};

const CAMPAIGN_HISTORY_PUBLIC_SELECT = [
  "id",
  "name",
  "channel",
  "template_name",
  "template_language",
  "message_text",
  "total_recipients",
  "successful_sends",
  "failed_sends",
  "sent_at",
  "estimated_cost",
  "cost_coverage_started_at",
  "unknown_cost_count",
  "delivery_rate",
  "read_rate",
  "open_rate",
  "click_rate",
  "unsubscribe_rate",
  "bounce_rate",
  "dispatch_status",
  "requested_at",
  "scheduled_at",
  "dispatch_expires_at",
  "started_at",
  "progress_at",
  "finished_at",
  "cancelled_at",
  "expired_at",
  "processed_count",
  "accepted_count",
  "attempted_count",
  "not_attempted_count",
  "stop_reason",
  "provider_circuit_state",
  "provider_circuit_provider",
  "provider_circuit_code",
  "provider_circuit_opened_at",
  "retry_of_campaign_id",
  "retry_kind",
].join(",");

function buildFailureSummary(aggregate: CampaignDispatchAggregate | null) {
  if (!aggregate || aggregate.delivery.failed === 0) return null;
  const topFailure = aggregate.topFailure;
  return {
    failedCount: aggregate.delivery.failed,
    topReason: topFailure?.reason ?? null,
    topErrorCode: topFailure?.errorCode ?? null,
    reasons: topFailure
      ? [
          {
            reason: topFailure.reason,
            count: topFailure.count,
            errorCode: topFailure.errorCode,
          },
        ]
      : [],
  };
}

function serializeCampaignHistoryRow(params: {
  campaign: CampaignHistoryRow;
  aggregate: CampaignDispatchAggregate | null;
  messages: ReturnType<typeof normalizeCampaignMessagePreview>[];
  replyStats: CampaignReplyStats | undefined;
}) {
  const campaign = params.campaign;
  const cost = resolveWhatsAppCampaignCostStatus(campaign);
  return {
    id: campaign.id ?? null,
    name: campaign.name ?? null,
    channel: campaign.channel ?? null,
    template_name: campaign.template_name ?? null,
    template_language: campaign.template_language ?? null,
    message_text: campaign.message_text ?? null,
    total_recipients: campaign.total_recipients ?? 0,
    successful_sends: campaign.successful_sends ?? 0,
    failed_sends: campaign.failed_sends ?? 0,
    sent_at: campaign.sent_at ?? null,
    estimated_cost: cost.amount,
    // Explains a missing WhatsApp amount instead of a bare blank.
    cost_status: campaign.channel === "whatsapp" ? cost.status : null,
    unpriced_message_count:
      campaign.channel === "whatsapp" ? cost.unpricedCount : null,
    delivery_rate: campaign.delivery_rate ?? null,
    read_rate: campaign.read_rate ?? null,
    open_rate: campaign.open_rate ?? null,
    click_rate: campaign.click_rate ?? null,
    unsubscribe_rate: campaign.unsubscribe_rate ?? null,
    bounce_rate: campaign.bounce_rate ?? null,
    users: null,
    failure_summary: buildFailureSummary(params.aggregate),
    messages: params.messages,
    reply_rate: params.replyStats?.replyRate ?? null,
    replied_count: params.replyStats?.replied ?? null,
    cost_per_reply: params.replyStats?.costPerReply ?? null,
    operation: serializeCampaignHistoryOperation({
      row: campaign,
      aggregate: params.aggregate,
    }),
  };
}

/**
 * GET - List campaign history for workspace
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId");
    const campaignId = searchParams.get("campaignId");
    const requestedPage = Number(searchParams.get("page") || "1");
    const requestedLimit = Number(searchParams.get("limit") || "20");
    if (
      !isCampaignOperationUuid(workspaceId) ||
      (campaignId !== null && !isCampaignOperationUuid(campaignId)) ||
      !Number.isSafeInteger(requestedPage) ||
      requestedPage < 1 ||
      !Number.isSafeInteger(requestedLimit) ||
      requestedLimit < 1
    ) {
      return NextResponse.json(
        { error: "Invalid campaign history request." },
        { status: 400 }
      );
    }
    const page = campaignId ? 1 : requestedPage;
    const limit = campaignId ? 1 : Math.min(requestedLimit, 100);
    const authorization =
      await getAuthenticatedWorkspaceMembership(workspaceId);
    if ("error" in authorization) {
      return (
        authorization.error ??
        NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      );
    }
    const supabase = authorization.supabase;

    let campaignsQuery = supabase
      .from("campaign_history")
      .select(CAMPAIGN_HISTORY_PUBLIC_SELECT, { count: "exact" })
      .eq("workspace_id", workspaceId);
    if (campaignId) campaignsQuery = campaignsQuery.eq("id", campaignId);

    const [campaignsResult, emailCampaignExistsResult] = await Promise.all([
      campaignsQuery
        .order("sent_at", { ascending: false })
        .range((page - 1) * limit, page * limit - 1),
      supabase
        .from("campaign_history")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("channel", "email")
        .limit(1),
    ]);

    const {
      data: campaigns,
      error,
      count,
    } = campaignsResult as {
      data: CampaignHistoryRow[] | null;
      error: SupabaseQueryError | null;
      count: number | null;
    };
    if (error) {
      return NextResponse.json(
        { error: "Failed to fetch campaigns" },
        { status: 500 }
      );
    }

    const hasEmailCampaigns =
      !emailCampaignExistsResult.error &&
      Array.isArray(emailCampaignExistsResult.data) &&
      emailCampaignExistsResult.data.length > 0;

    const campaignIds = (campaigns || [])
      .map(campaign =>
        typeof campaign.id === "string" && campaign.id.trim()
          ? campaign.id
          : null
      )
      .filter((id): id is string => Boolean(id));
    let messagePreviews = new Map<
      string,
      ReturnType<typeof normalizeCampaignMessagePreview>[]
    >();
    let aggregates = new Map<string, CampaignDispatchAggregate>();
    let aggregatesAvailable = true;
    const messagePreviewLimit = 1000;

    if (campaignIds.length > 0) {
      try {
        aggregates = await getCampaignDispatchBatchAggregates({
          supabase: supabaseAdmin,
          workspaceId,
          campaignIds,
        });
      } catch (aggregateError) {
        aggregatesAvailable = false;
        logger.warn("campaign.history_aggregate_unavailable", {
          event: "campaign.history_aggregate_unavailable",
          workspaceId,
          campaignCount: campaignIds.length,
          error:
            aggregateError instanceof Error
              ? aggregateError.message
              : String(aggregateError),
        });
      }

      let messagePreviewResult = (await supabase
        .from("campaign_messages")
        .select(
          "id, campaign_id, message_id, channel, recipient, phone, provider, status, error_code, error_message, failure_reason, created_at, updated_at, delivered_at, read_at, opened_at, clicked_at, bounced_at"
        )
        .in("campaign_id", campaignIds)
        .order("created_at", { ascending: true })
        .limit(messagePreviewLimit)) as {
        data: CampaignMessagePreviewRow[] | null;
        error: SupabaseQueryError | null;
      };

      if (isMissingFailureReasonColumnError(messagePreviewResult.error)) {
        messagePreviewResult = (await supabase
          .from("campaign_messages")
          .select(
            "id, campaign_id, message_id, channel, recipient, phone, provider, status, error_code, error_message, created_at, updated_at, delivered_at, read_at, opened_at, clicked_at, bounced_at"
          )
          .in("campaign_id", campaignIds)
          .order("created_at", { ascending: true })
          .limit(messagePreviewLimit)) as {
          data: CampaignMessagePreviewRow[] | null;
          error: SupabaseQueryError | null;
        };
      }

      if (messagePreviewResult.error) {
        logger.warn("campaign.history_message_preview_unavailable", {
          event: "campaign.history_message_preview_unavailable",
          workspaceId,
          campaignCount: campaignIds.length,
          error: messagePreviewResult.error.message ?? "Unknown error",
        });
      } else {
        messagePreviews = groupCampaignMessagePreviews(
          (messagePreviewResult.data || []) as CampaignMessagePreviewRow[]
        );
      }
    }

    let replyStatsByCampaign = new Map<string, CampaignReplyStats>();
    try {
      replyStatsByCampaign = await attachWhatsAppCampaignReplyStats({
        workspaceId,
        signal: request.signal,
        campaigns: (campaigns || []).flatMap(campaign =>
          typeof campaign.id === "string"
            ? [
                {
                  id: campaign.id,
                  channel: campaign.channel,
                  estimated_cost: campaign.estimated_cost,
                  cost_coverage_started_at: campaign.cost_coverage_started_at,
                  unknown_cost_count: campaign.unknown_cost_count,
                  successful_sends: campaign.successful_sends,
                },
              ]
            : []
        ),
      });
    } catch (replyStatsError) {
      logger.warn("campaign.history_reply_stats_unavailable", {
        event: "campaign.history_reply_stats_unavailable",
        workspaceId,
        campaignCount: campaignIds.length,
        error:
          replyStatsError instanceof Error
            ? replyStatsError.message
            : String(replyStatsError),
      });
    }

    return NextResponse.json(
      {
        campaigns: (campaigns || []).map(campaign => {
          const campaignId = typeof campaign.id === "string" ? campaign.id : "";
          return serializeCampaignHistoryRow({
            campaign,
            aggregate:
              aggregatesAvailable && campaignId
                ? (aggregates.get(campaignId) ?? null)
                : null,
            messages: campaignId ? (messagePreviews.get(campaignId) ?? []) : [],
            replyStats: campaignId
              ? replyStatsByCampaign.get(campaignId)
              : undefined,
          });
        }),
        hasEmailCampaigns,
        pagination: {
          page,
          limit,
          total: count || 0,
          pages: Math.ceil((count || 0) / limit),
        },
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    logger.error("campaign.history_load_failed", error, {
      event: "campaign.history_load_failed",
    });
    return NextResponse.json(
      { error: "Failed to fetch campaign history." },
      { status: 500 }
    );
  }
}

export function POST() {
  return NextResponse.json(
    {
      code: "campaign_history_write_disabled",
      error:
        "Campaign history is written only by canonical campaign admission.",
    },
    {
      status: 405,
      headers: { Allow: "GET" },
    }
  );
}
