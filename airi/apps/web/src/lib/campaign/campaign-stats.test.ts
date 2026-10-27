import { reconcileLegacyCampaignSendTotals } from "@/lib/campaign/campaign-stats";
import { supabaseAdmin } from "@/lib/supabase/admin";

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    rpc: jest.fn(),
  },
}));

const mockRpc = supabaseAdmin.rpc as jest.Mock;

describe("reconcileLegacyCampaignSendTotals", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("persists legacy workflow totals without reading an absent recipient ledger", async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });

    await expect(
      reconcileLegacyCampaignSendTotals({
        workspaceId: "workspace-1",
        campaignId: "campaign-legacy",
        totals: {
          successfulSends: 41,
          failedSends: 9,
        },
      })
    ).resolves.toEqual({ ok: true });

    expect(mockRpc).toHaveBeenCalledWith(
      "reconcile_legacy_bulk_campaign_send_totals",
      {
        p_workspace_id: "workspace-1",
        p_campaign_id: "campaign-legacy",
        p_successful_sends: 41,
        p_failed_sends: 9,
      }
    );
  });
});
