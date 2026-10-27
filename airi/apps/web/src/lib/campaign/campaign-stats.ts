import { supabaseAdmin } from "@/lib/supabase/admin";

export async function reconcileLegacyCampaignSendTotals(params: {
  workspaceId: string;
  campaignId: string;
  totals: { successfulSends: number; failedSends: number };
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await supabaseAdmin.rpc(
    "reconcile_legacy_bulk_campaign_send_totals",
    {
      p_workspace_id: params.workspaceId,
      p_campaign_id: params.campaignId,
      p_successful_sends: params.totals.successfulSends,
      p_failed_sends: params.totals.failedSends,
    }
  );

  if (error) {
    return { ok: false, error: error.message };
  }
  if (data !== true) {
    return {
      ok: false,
      error: "Legacy campaign not found or already ledger-managed",
    };
  }
  return { ok: true };
}
