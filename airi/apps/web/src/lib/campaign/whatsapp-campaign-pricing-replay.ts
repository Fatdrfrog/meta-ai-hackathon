import connectDB from "@/lib/mongoose";
import { supabaseAdmin } from "@/lib/supabase/admin";
import MessageDeliveryEvent from "@/models/message-delivery-event";
import { buildWhatsAppCampaignPricingReceiptPatch } from "@icecore/shared/constants/whatsapp-message-rates";

/**
 * A campaign sent before cost coverage keeps its legacy estimate. Replaying it
 * would certify coverage and recompute the total as unknown, erasing that value.
 */
async function hasLegacyWhatsAppCostEstimate(campaign: {
  id: string;
  estimated_cost?: number | string | null;
  cost_coverage_started_at?: string | null;
}): Promise<boolean> {
  if (campaign.cost_coverage_started_at) return false;
  if (campaign.estimated_cost !== null && campaign.estimated_cost !== undefined)
    return true;
  const { data, error } = await supabaseAdmin
    .from("campaign_messages")
    .select("id")
    .eq("campaign_id", campaign.id)
    .eq("cost_coverage", "unknown")
    .gt("estimated_cost_usd", 0)
    .limit(1);
  if (error)
    throw new Error("WhatsApp pricing replay legacy check unavailable");
  return (data || []).length > 0;
}

/** Explicit repair only. Reads bounded pages; dry-run is the default. No tariff guesses. */
export async function replayWhatsAppCampaignPricingPage(params: {
  workspaceId: string;
  campaignId: string;
  afterId?: string;
  limit?: number;
  dryRun?: boolean;
}) {
  const limit = Math.max(1, Math.min(500, Math.floor(params.limit || 250)));
  // Verify workspace ownership before the service-role message lookup/write.
  const { data: campaign, error: campaignError } = await supabaseAdmin
    .from("campaign_history")
    .select("id,estimated_cost,cost_coverage_started_at")
    .eq("id", params.campaignId)
    .eq("workspace_id", params.workspaceId)
    .eq("channel", "whatsapp")
    .maybeSingle();
  if (campaignError || !campaign)
    throw new Error(
      "WhatsApp pricing replay campaign unavailable in workspace"
    );
  // Report legacy campaigns, but never write to them.
  const legacyEstimate = await hasLegacyWhatsAppCostEstimate(campaign);
  const write = params.dryRun === false && !legacyEstimate;
  let query = supabaseAdmin
    .from("campaign_messages")
    .select("id,message_id,estimated_cost_usd,cost_coverage")
    .eq("campaign_id", params.campaignId)
    .eq("channel", "whatsapp")
    .order("id")
    .limit(limit + 1);
  if (params.afterId) query = query.gt("id", params.afterId);
  const { data, error } = await query;
  if (error) throw new Error("WhatsApp pricing replay messages unavailable");
  const page = (data || []) as Array<{
    id: string;
    message_id?: string | null;
    estimated_cost_usd?: number | string | null;
    cost_coverage?: string | null;
  }>;
  const rows = page.slice(0, limit),
    ids = rows.flatMap(row => (row.message_id ? [row.message_id] : []));
  await connectDB();
  const receipts: Array<{
    _id: string;
    receipt: {
      pricingType?: string;
      pricingBillable?: boolean;
      pricingCategory?: string;
      eventAt: Date;
    };
  }> = ids.length
    ? await MessageDeliveryEvent.aggregate([
        {
          $match: {
            workspaceId: params.workspaceId,
            messageId: { $in: ids },
            $or: [
              { pricingType: { $ne: null } },
              { pricingBillable: { $ne: null } },
            ],
          },
        },
        { $sort: { messageId: 1, eventAt: -1, _id: -1 } },
        {
          $group: {
            _id: "$messageId",
            receipt: {
              $first: {
                pricingType: "$pricingType",
                pricingBillable: "$pricingBillable",
                pricingCategory: "$pricingCategory",
                eventAt: "$eventAt",
              },
            },
          },
        },
        { $limit: 500 },
      ])
        .allowDiskUse(true)
        .option({ maxTimeMS: 15000 })
    : [];
  const byId = new Map<
    string,
    {
      pricingType?: string;
      pricingBillable?: boolean;
      pricingCategory?: string;
      eventAt: Date;
    }
  >(receipts.map(row => [String(row._id), row.receipt]));
  let observed = 0,
    free = 0,
    unknown = 0;
  for (const row of rows) {
    const receipt = row.message_id ? byId.get(row.message_id) : undefined;
    const patch = receipt
      ? buildWhatsAppCampaignPricingReceiptPatch(
          {
            type: receipt.pricingType,
            billable: receipt.pricingBillable,
            category: receipt.pricingCategory,
          },
          new Date(receipt.eventAt)
        )
      : undefined;
    if (!patch) {
      unknown++;
      continue;
    }
    observed++;
    if (patch.cost_coverage === "provider_free") free++;
    else unknown++;
    if (!write) continue;
    // An unpriced receipt adds no price; keep any stored message estimate.
    const keepStoredCost =
      patch.cost_coverage === "unknown" &&
      (row.cost_coverage ?? "unknown") === "unknown" &&
      row.estimated_cost_usd !== null &&
      row.estimated_cost_usd !== undefined;
    const { error: updateError } = await supabaseAdmin
      .from("campaign_messages")
      .update(
        keepStoredCost
          ? Object.fromEntries(
              Object.entries(patch).filter(
                ([key]) => key !== "estimated_cost_usd"
              )
            )
          : patch
      )
      .eq("id", row.id)
      .eq("campaign_id", params.campaignId)
      .eq("channel", "whatsapp");
    if (updateError)
      throw new Error("WhatsApp pricing replay receipt update unavailable");
  }
  const hasMore = page.length > limit;
  if (!hasMore && write) {
    const { error: recomputeError } = await supabaseAdmin.rpc(
      "recompute_bulk_campaign_stats",
      { p_campaign_id: params.campaignId }
    );
    if (recomputeError)
      throw new Error(
        "WhatsApp pricing replay aggregate recomputation unavailable"
      );
  }
  return {
    scanned: rows.length,
    observed,
    free,
    unknown,
    hasMore,
    nextId: rows.at(-1)?.id || null,
    dryRun: params.dryRun !== false,
    skipped: legacyEstimate ? ("legacy_estimate" as const) : null,
  };
}
