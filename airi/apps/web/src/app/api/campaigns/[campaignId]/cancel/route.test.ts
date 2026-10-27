const mockGetAuthenticatedWorkspaceMembership = jest.fn();
const mockCancelCampaignDispatch = jest.fn();
const mockCancelBulkCampaignDispatchWorkflow = jest.fn();

jest.mock("@/lib/auth/workspace-membership", () => ({
  getAuthenticatedWorkspaceMembership: (...args: unknown[]) =>
    mockGetAuthenticatedWorkspaceMembership(...args),
}));

jest.mock("@/lib/campaign/campaign-history-store", () => ({
  cancelCampaignDispatch: (...args: unknown[]) =>
    mockCancelCampaignDispatch(...args),
}));

jest.mock("@/lib/temporal/bulk-campaign-dispatch", () => ({
  cancelBulkCampaignDispatchWorkflow: (...args: unknown[]) =>
    mockCancelBulkCampaignDispatchWorkflow(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: { error: jest.fn() },
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { kind: "service-role" },
}));

import { NextResponse } from "next/server";

import { POST } from "./route";
import {
  CAMPAIGN_ID,
  WORKSPACE_ID,
  context,
  controlRequest,
  workspaceMembership,
} from "../campaign-control-route-test-utils";

const WORKFLOW_ID = "bulk-campaign:persisted-workflow-id";

const TEMPORAL_CANCEL_FAILED = {
  code: "temporal_cancel_failed",
  error:
    "Campaign was cancelled locally, but workflow cancellation could not be confirmed.",
  campaignId: CAMPAIGN_ID,
  status: "cancelled",
  retryable: true,
};

function cancel() {
  return POST(
    controlRequest("cancel", { workspaceId: WORKSPACE_ID }),
    context()
  );
}

function expectNothingCancelled() {
  expect(mockCancelCampaignDispatch).not.toHaveBeenCalled();
  expect(mockCancelBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
}

describe("POST /api/campaigns/[campaignId]/cancel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthenticatedWorkspaceMembership.mockResolvedValue(
      workspaceMembership()
    );
    mockCancelCampaignDispatch.mockResolvedValue({
      outcome: "cancelled",
      campaignId: CAMPAIGN_ID,
      workflowId: WORKFLOW_ID,
      status: "cancelled",
    });
    mockCancelBulkCampaignDispatchWorkflow.mockResolvedValue({
      outcome: "cancelled",
    });
  });

  it.each([
    ["invalid campaign id", { workspaceId: WORKSPACE_ID }, "invalid"],
    ["invalid workspace id", { workspaceId: "invalid" }, CAMPAIGN_ID],
    [
      "unknown body fields",
      { workspaceId: WORKSPACE_ID, workflowId: "attacker-controlled" },
      CAMPAIGN_ID,
    ],
  ])("strictly rejects %s", async (_label, body, campaignId) => {
    const response = await POST(
      controlRequest("cancel", body),
      context(campaignId)
    );

    expect(response.status).toBe(400);
    expectNothingCancelled();
  });

  it("authorizes manager roles before touching the service store", async () => {
    mockGetAuthenticatedWorkspaceMembership.mockResolvedValue(
      workspaceMembership("agent")
    );

    const response = await cancel();

    expect(response.status).toBe(403);
    expectNothingCancelled();
  });

  it("preserves membership failures without touching admin state or Temporal", async () => {
    mockGetAuthenticatedWorkspaceMembership.mockResolvedValue({
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });

    const response = await cancel();

    expect(response.status).toBe(403);
    expectNothingCancelled();
  });

  it("commits local cancellation before cancelling the exact persisted workflow", async () => {
    const response = await cancel();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      campaignId: CAMPAIGN_ID,
      status: "cancelled",
      outcome: "cancelled",
      temporalCancellation: "cancelled",
    });
    expect(mockCancelCampaignDispatch).toHaveBeenCalledWith({
      supabase: { kind: "service-role" },
      workspaceId: WORKSPACE_ID,
      campaignId: CAMPAIGN_ID,
    });
    expect(mockCancelBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      WORKFLOW_ID
    );
    expect(mockCancelCampaignDispatch.mock.invocationCallOrder[0]).toBeLessThan(
      mockCancelBulkCampaignDispatchWorkflow.mock.invocationCallOrder[0]
    );
  });

  it("retries Temporal healing for an already-locally-cancelled campaign", async () => {
    mockCancelCampaignDispatch.mockResolvedValue({
      outcome: "already_cancelled",
      campaignId: CAMPAIGN_ID,
      workflowId: WORKFLOW_ID,
      status: "cancelled",
    });
    mockCancelBulkCampaignDispatchWorkflow.mockResolvedValue({
      outcome: "already_closed",
    });

    const response = await cancel();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      campaignId: CAMPAIGN_ID,
      status: "cancelled",
      outcome: "already_cancelled",
      temporalCancellation: "already_closed",
    });
    expect(mockCancelBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      WORKFLOW_ID
    );
  });

  it("returns a stable healing response when Temporal transport fails after local cancellation", async () => {
    mockCancelBulkCampaignDispatchWorkflow.mockRejectedValue(
      new Error("Temporal unavailable")
    );

    const response = await cancel();

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual(TEMPORAL_CANCEL_FAILED);
  });

  it("fails closed without calling Temporal when an active ledger row has no workflow id", async () => {
    mockCancelCampaignDispatch.mockResolvedValue({
      outcome: "cancelled",
      campaignId: CAMPAIGN_ID,
      workflowId: null,
      status: "cancelled",
    });

    const response = await cancel();

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual(TEMPORAL_CANCEL_FAILED);
    expect(mockCancelBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    [
      {
        outcome: "not_found",
        workflowId: null,
        status: null,
      },
      404,
      "campaign_not_found",
    ],
    [
      {
        outcome: "already_terminal",
        campaignId: CAMPAIGN_ID,
        workflowId: WORKFLOW_ID,
        status: "completed",
      },
      409,
      "campaign_not_cancellable",
    ],
  ])(
    "does not cancel Temporal for non-cancellable local outcome %#",
    async (localResult, expectedStatus, expectedCode) => {
      mockCancelCampaignDispatch.mockResolvedValue(localResult);

      const response = await cancel();

      expect(response.status).toBe(expectedStatus);
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({ code: expectedCode })
      );
      expect(mockCancelBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
    }
  );
});
