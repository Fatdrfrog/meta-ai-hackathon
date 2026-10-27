const mockGetAuthenticatedWorkspaceMembership = jest.fn();
const mockGetCampaignDispatchStatus = jest.fn();

jest.mock("@/lib/auth/workspace-membership", () => ({
  getAuthenticatedWorkspaceMembership: (...args: unknown[]) =>
    mockGetAuthenticatedWorkspaceMembership(...args),
}));

jest.mock("@/lib/campaign/campaign-history-store", () => ({
  getCampaignDispatchStatus: (...args: unknown[]) =>
    mockGetCampaignDispatchStatus(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: { error: jest.fn() },
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { kind: "service-role" },
}));

import { NextResponse } from "next/server";

import { GET } from "./route";
import {
  CAMPAIGN_ID,
  WORKSPACE_ID,
  context,
  workspaceMembership,
} from "../campaign-control-route-test-utils";

function request(workspaceId = WORKSPACE_ID) {
  return new Request(
    `https://airi.test/api/campaigns/${CAMPAIGN_ID}/status?workspaceId=${workspaceId}`
  );
}

/** The private dispatch row the status store returns for a running send. */
function dispatchStatus(overrides: Record<string, unknown> = {}) {
  return {
    campaignId: CAMPAIGN_ID,
    workspaceId: WORKSPACE_ID,
    workflowId: "bulk-campaign:private-workflow-id",
    status: "running",
    requestedAt: "2026-07-24T09:00:00.000Z",
    scheduledAt: null,
    dispatchExpiresAt: "2026-07-24T09:15:00.000Z",
    startedAt: "2026-07-24T09:01:00.000Z",
    progressAt: "2026-07-24T09:02:00.000Z",
    finishedAt: null,
    cancelledAt: null,
    expiredAt: null,
    totalRecipients: 5,
    progress: {
      processed: 3,
      accepted: 2,
      attempted: 3,
      notAttempted: 2,
      successful: 2,
      failed: 1,
    },
    delivery: {
      pending: 2,
      accepted: 1,
      delivered: 1,
      read: 0,
      failed: 1,
    },
    stopReason: null,
    providerCircuit: {
      state: "closed",
      provider: null,
      code: null,
      openedAt: null,
      failureCount: 0,
    },
    retry: {
      ofCampaignId: null,
      kind: null,
    },
    retryableFailedRecipientCount: 1,
    ...overrides,
  };
}

describe("GET /api/campaigns/[campaignId]/status", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthenticatedWorkspaceMembership.mockResolvedValue(
      workspaceMembership()
    );
    mockGetCampaignDispatchStatus.mockResolvedValue(dispatchStatus());
  });

  it.each([
    ["campaign id", request(), context("not-a-uuid")],
    ["workspace id", request("not-a-uuid"), context()],
  ])(
    "strictly rejects an invalid %s before authorization",
    async (_label, req, ctx) => {
      const response = await GET(req, ctx);

      expect(response.status).toBe(400);
      expect(mockGetAuthenticatedWorkspaceMembership).not.toHaveBeenCalled();
      expect(mockGetCampaignDispatchStatus).not.toHaveBeenCalled();
    }
  );

  it.each([
    [401, "Unauthorized"],
    [403, "Forbidden"],
  ])("preserves membership authorization status %s", async (status, error) => {
    mockGetAuthenticatedWorkspaceMembership.mockResolvedValue({
      error: NextResponse.json({ error }, { status }),
    });

    const response = await GET(request(), context());

    expect(response.status).toBe(status);
    expect(mockGetCampaignDispatchStatus).not.toHaveBeenCalled();
  });

  it("returns a workspace-scoped 404 without leaking cross-workspace state", async () => {
    mockGetCampaignDispatchStatus.mockResolvedValue(null);

    const response = await GET(request(), context());

    expect(response.status).toBe(404);
    expect(mockGetCampaignDispatchStatus).toHaveBeenCalledWith({
      supabase: { kind: "service-role" },
      workspaceId: WORKSPACE_ID,
      campaignId: CAMPAIGN_ID,
    });
  });

  it("returns only the explicit public aggregate operation contract", async () => {
    const response = await GET(request(), context());
    expect(response.headers.get("cache-control")).toBe("private, no-store");

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      campaignId: CAMPAIGN_ID,
      status: "running",
      requestedAt: "2026-07-24T09:00:00.000Z",
      scheduledAt: null,
      dispatchExpiresAt: "2026-07-24T09:15:00.000Z",
      startedAt: "2026-07-24T09:01:00.000Z",
      progressAt: "2026-07-24T09:02:00.000Z",
      finishedAt: null,
      cancelledAt: null,
      expiredAt: null,
      totalRecipients: 5,
      progress: {
        processed: 3,
        accepted: 2,
        attempted: 3,
        notAttempted: 2,
        successful: 2,
        failed: 1,
      },
      delivery: {
        pending: 2,
        accepted: 1,
        delivered: 1,
        read: 0,
        failed: 1,
      },
      stopReason: null,
      providerCircuit: {
        state: "closed",
        provider: null,
        code: null,
        openedAt: null,
        failureCount: 0,
        requiresAcknowledgement: false,
      },
      retry: {
        ofCampaignId: null,
        kind: null,
        failedRecipientCount: 1,
        available: false,
      },
      canCancel: true,
      paused: false,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("workspaceId");
    expect(serialized).not.toContain("workflowId");
    expect(serialized).not.toContain("recipient_hash");
    expect(serialized).not.toContain("dispatch_snapshot");
    expect(serialized).not.toContain("770");
  });

  it.each([
    {
      label: "bounced-only",
      deliveryFailed: 2,
      retryableFailed: 0,
      available: false,
    },
    {
      label: "mixed failed and bounced",
      deliveryFailed: 3,
      retryableFailed: 1,
      available: true,
    },
  ])(
    "reports truthful retry availability for $label terminal delivery failures",
    async ({
      deliveryFailed,
      retryableFailed,
      available,
    }: {
      deliveryFailed: number;
      retryableFailed: number;
      available: boolean;
    }) => {
      mockGetCampaignDispatchStatus.mockResolvedValue(
        dispatchStatus({
          status: "failed",
          finishedAt: "2026-07-24T09:03:00.000Z",
          totalRecipients: 3,
          progress: {
            processed: 3,
            accepted: 0,
            attempted: 3,
            notAttempted: 0,
            successful: 0,
            failed: deliveryFailed,
          },
          delivery: {
            pending: 0,
            accepted: 0,
            delivered: 0,
            read: 0,
            failed: deliveryFailed,
          },
          stopReason: "provider_failure",
          retryableFailedRecipientCount: retryableFailed,
        })
      );

      const response = await GET(request(), context());
      const payload = await response.json();

      expect(payload.delivery.failed).toBe(deliveryFailed);
      expect(payload.retry).toEqual({
        ofCampaignId: null,
        kind: null,
        failedRecipientCount: retryableFailed,
        available,
      });
    }
  );
});
