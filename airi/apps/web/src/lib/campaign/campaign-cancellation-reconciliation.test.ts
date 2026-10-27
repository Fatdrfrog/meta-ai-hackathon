/**
 * @jest-environment node
 */

import { reconcileCampaignDispatchCancellation } from "./campaign-history-store";

describe("bulk campaign cancellation reconciliation", () => {
  const now = new Date("2026-07-24T08:00:00.000Z");

  it("uses one row-locked RPC for terminal-safe cancellation progress", async () => {
    const rpc = jest.fn(async () => ({
      data: {
        applied: true,
        outcome: "already_cancelled",
        campaign_id: "20000000-0000-4000-8000-000000000002",
        dispatch_status: "cancelled",
        workflow_id: "workflow-1",
      },
      error: null,
    }));

    await expect(
      reconcileCampaignDispatchCancellation({
        supabase: { from: jest.fn(), rpc },
        workspaceId: "10000000-0000-4000-8000-000000000001",
        campaignId: "20000000-0000-4000-8000-000000000002",
        processedCount: 3,
        acceptedCount: 2,
        failedCount: 1,
        attemptedCount: 3,
        notAttemptedCount: 2,
        stopReason: "workflow_cancelled",
        providerCircuit: {
          state: "closed",
        },
        now,
      })
    ).resolves.toEqual({
      outcome: "already_cancelled",
      campaignId: "20000000-0000-4000-8000-000000000002",
      status: "cancelled",
      workflowId: "workflow-1",
    });

    expect(rpc).toHaveBeenCalledWith("reconcile_bulk_campaign_cancellation", {
      p_campaign_id: "20000000-0000-4000-8000-000000000002",
      p_workspace_id: "10000000-0000-4000-8000-000000000001",
      p_processed_count: 3,
      p_accepted_count: 2,
      p_failed_count: 1,
      p_attempted_count: 3,
      p_not_attempted_count: 2,
      p_stop_reason: "workflow_cancelled",
      p_provider_circuit_state: "closed",
      p_provider_circuit_provider: null,
      p_provider_circuit_code: null,
      p_now: now.toISOString(),
    });
  });
});
