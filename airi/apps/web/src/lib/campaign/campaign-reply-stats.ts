import connectDB from "@/lib/mongoose";
import { createHash } from "node:crypto";
import { buildCacheKey } from "@icecore/shared/lib/cache";
import { awaitWithCancellation } from "@/lib/ai/cancellation";
import { buildEnrichmentStages } from "@/lib/analytics/bulk-analytics-audience";
import {
  readCachedLocalAnalytics,
  withAnalyticsQueryBudget,
  type AnalyticsQueryBudget,
} from "@/lib/analytics/analytics-query-service";
import {
  finalizeCostPerReplyValue,
  resolveWhatsAppCampaignReportedCost,
} from "@/lib/campaign/whatsapp-campaign-cost";
import { supabaseAdmin } from "@/lib/supabase/admin";
import Message from "@/models/message";

const DEFAULT_REPLY_WINDOW_HOURS = 168;
const MAX_MESSAGE_IDS = 20_000;

export type CampaignReplyStats = {
  replied: number;
  accepted: number;
  replyRate: number | null;
  costPerReply: number | null;
};

type CampaignReplyStatsInput = {
  id: string;
  channel?: string | null;
  estimated_cost?: number | null;
  cost_coverage_started_at?: string | null;
  unknown_cost_count?: number | null;
  successful_sends?: number | null;
};

type CampaignMessageRow = {
  campaign_id?: string | null;
  message_id?: string | null;
  status?: string | null;
};

type CampaignReplyObservation = {
  counts: Array<[string, { accepted?: number; replied: number }]>;
  hasMessageIds: boolean;
};

function calculatePercent(
  numerator: number,
  denominator: number
): number | null {
  if (!denominator || denominator <= 0) return null;
  return (numerator / denominator) * 100;
}

function isFailedStatus(status: unknown): boolean {
  const normalized = String(status || "")
    .trim()
    .toLowerCase();
  return (
    normalized === "failed" ||
    normalized === "skipped" ||
    normalized === "bounce" ||
    normalized === "bounced"
  );
}

/**
 * Batch reply attribution for WhatsApp campaign history rows.
 * Reuses bulk analytics attribution, cache coordination and execution budget.
 * Only reply observations are cached; dispatch progress and cost coverage stay live.
 */
export async function attachWhatsAppCampaignReplyStats(params: {
  workspaceId: string;
  campaigns: CampaignReplyStatsInput[];
  replyWindowHours?: number;
  signal?: AbortSignal;
}): Promise<Map<string, CampaignReplyStats>> {
  params.signal?.throwIfAborted();
  const workspaceId = String(params.workspaceId || "").trim();
  const replyWindowHours =
    params.replyWindowHours && params.replyWindowHours > 0
      ? params.replyWindowHours
      : DEFAULT_REPLY_WINDOW_HOURS;

  const whatsappCampaigns = params.campaigns.filter(
    campaign => String(campaign.channel || "").toLowerCase() === "whatsapp"
  );
  const result = new Map<string, CampaignReplyStats>();

  for (const campaign of whatsappCampaigns) {
    result.set(campaign.id, {
      replied: 0,
      accepted: Math.max(0, Number(campaign.successful_sends || 0)),
      replyRate: null,
      costPerReply: null,
    });
  }

  if (!workspaceId || whatsappCampaigns.length === 0) {
    return result;
  }

  const campaignIds = Array.from(
    new Set(whatsappCampaigns.map(campaign => campaign.id))
  ).sort();
  const key = buildCacheKey("campaign:reply-stats:v1", [
    workspaceId,
    createHash("sha256")
      .update(JSON.stringify([replyWindowHours, campaignIds]))
      .digest("hex"),
  ]);
  const shared = withAnalyticsQueryBudget({
    run: budget =>
      readCachedLocalAnalytics({
        key,
        signal: budget.signal,
        run: () =>
          readCampaignReplyObservation({
            workspaceId,
            campaignIds,
            replyWindowHours,
            budget,
          }),
      }),
  });
  // A departing viewer must not cancel an observation other viewers share.
  const observation = await awaitWithCancellation(shared, params.signal);
  for (const [campaignId, counts] of observation.counts) {
    const current = result.get(campaignId);
    if (!current) continue;
    const accepted = counts.accepted ?? current.accepted;
    result.set(campaignId, {
      ...current,
      accepted,
      replied: counts.replied,
      replyRate: observation.hasMessageIds
        ? calculatePercent(counts.replied, accepted)
        : null,
    });
  }
  return finalizeCostPerReply(result, whatsappCampaigns);
}

async function readCampaignReplyObservation(params: {
  workspaceId: string;
  campaignIds: string[];
  replyWindowHours: number;
  budget: AnalyticsQueryBudget;
}): Promise<CampaignReplyObservation> {
  const { workspaceId, campaignIds, replyWindowHours, budget } = params;
  budget.remainingMs();
  const { data: messageRows, error } = await supabaseAdmin
    .from("campaign_messages")
    .select("campaign_id, message_id, status")
    .in("campaign_id", campaignIds)
    .limit(MAX_MESSAGE_IDS)
    .abortSignal(budget.signal);

  budget.remainingMs();
  if (error) {
    throw new Error(error.message);
  }

  const requestedCampaigns = new Set(campaignIds);
  const messageIdToCampaignId = new Map<string, string>();
  const acceptedByCampaign = new Map<string, number>();

  for (const row of (messageRows || []) as CampaignMessageRow[]) {
    const campaignId =
      typeof row.campaign_id === "string" ? row.campaign_id.trim() : "";
    const messageId =
      typeof row.message_id === "string" ? row.message_id.trim() : "";
    if (!campaignId || !messageId || !requestedCampaigns.has(campaignId))
      continue;
    if (isFailedStatus(row.status)) continue;

    messageIdToCampaignId.set(messageId, campaignId);
    acceptedByCampaign.set(
      campaignId,
      (acceptedByCampaign.get(campaignId) || 0) + 1
    );
  }

  const messageIds = Array.from(messageIdToCampaignId.keys());
  if (messageIds.length === 0) {
    return {
      counts: campaignIds.map(campaignId => [campaignId, { replied: 0 }]),
      hasMessageIds: false,
    };
  }

  await connectDB();
  budget.remainingMs();

  type ReplyRow = {
    messageId?: string | null;
    replied?: boolean | null;
  };

  const replyRows = (await Message.aggregate<ReplyRow>([
    {
      $match: {
        workspaceId,
        channel: "whatsapp",
        direction: "outbound",
        messageId: { $in: messageIds },
      },
    },
    ...buildEnrichmentStages({
      workspaceId,
      replyWindowHours,
    }),
    {
      $project: {
        _id: 0,
        messageId: 1,
        replied: 1,
      },
    },
  ])
    .allowDiskUse(true)
    .option({
      maxTimeMS: budget.remainingMs(),
      signal: budget.signal,
    })) as ReplyRow[];
  budget.remainingMs();

  const repliedByCampaign = new Map<string, number>();
  for (const row of replyRows) {
    const messageId =
      typeof row.messageId === "string" ? row.messageId.trim() : "";
    if (!messageId || !row.replied) continue;
    const campaignId = messageIdToCampaignId.get(messageId);
    if (!campaignId) continue;
    repliedByCampaign.set(
      campaignId,
      (repliedByCampaign.get(campaignId) || 0) + 1
    );
  }

  return {
    counts: campaignIds.map(campaignId => [
      campaignId,
      {
        accepted: acceptedByCampaign.get(campaignId),
        replied: repliedByCampaign.get(campaignId) || 0,
      },
    ]),
    hasMessageIds: true,
  };
}

function finalizeCostPerReply(
  stats: Map<string, CampaignReplyStats>,
  campaigns: CampaignReplyStatsInput[]
): Map<string, CampaignReplyStats> {
  for (const campaign of campaigns) {
    const current = stats.get(campaign.id);
    if (!current) continue;
    const cost = resolveWhatsAppCampaignReportedCost(campaign);
    stats.set(campaign.id, {
      ...current,
      costPerReply: finalizeCostPerReplyValue(cost, current.replied),
    });
  }
  return stats;
}
