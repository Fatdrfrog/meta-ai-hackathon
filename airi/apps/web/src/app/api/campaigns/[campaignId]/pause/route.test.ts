const mockGetAuthenticatedWorkspaceMembership = jest.fn();
const mockGetCampaignDispatchStatus = jest.fn();
const mockSetCampaignDispatchPaused = jest.fn();
const mockSignalBulkCampaignDispatchPause = jest.fn();
const mockIsBulkCampaignPauseUnsupportedError = jest.fn();

jest.mock("@/lib/auth/workspace-membership", () => ({
  getAuthenticatedWorkspaceMembership: (...args: unknown[]) =>
    mockGetAuthenticatedWorkspaceMembership(...args),
}));

jest.mock("@/lib/campaign/campaign-history-store", () => ({
  getCampaignDispatchStatus: (...args: unknown[]) =>
    mockGetCampaignDispatchStatus(...args),
  setCampaignDispatchPaused: (...args: unknown[]) =>
    mockSetCampaignDispatchPaused(...args),
}));

jest.mock("@/lib/temporal/bulk-campaign-dispatch", () => ({
  signalBulkCampaignDispatchPause: (...args: unknown[]) =>
    mockSignalBulkCampaignDispatchPause(...args),
  isBulkCampaignPauseUnsupportedError: (...args: unknown[]) =>
    mockIsBulkCampaignPauseUnsupportedError(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: { error: jest.fn() },
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { kind: "service-role" },
}));

import { loadTemporalClientSdk } from "@/lib/temporal/sdk";
import { NextResponse } from "next/server";

import { POST } from "./route";
import {
  CAMPAIGN_ID,
  WORKSPACE_ID,
  context,
  controlRequest,
  workspaceMembership,
} from "../campaign-control-route-test-utils";

const { WorkflowNotFoundError } = loadTemporalClientSdk();

const WORKFLOW_ID = "bulk-campaign-dispatch:workspace:campaign";

function request(body: unknown) {
  return controlRequest("pause", body);
}

function pause() {
  return POST(request({ workspaceId: WORKSPACE_ID, paused: true }), context());
}

describe("POST /api/campaigns/[campaignId]/pause", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsBulkCampaignPauseUnsupportedError.mockReturnValue(false);
    mockGetAuthenticatedWorkspaceMembership.mockResolvedValue(
      workspaceMembership()
    );
    mockGetCampaignDispatchStatus.mockResolvedValue({
      campaignId: CAMPAIGN_ID,
      workspaceId: WORKSPACE_ID,
      workflowId: WORKFLOW_ID,
      status: "running",
    });
    mockSignalBulkCampaignDispatchPause.mockResolvedValue({ paused: true });
    mockSetCampaignDispatchPaused.mockResolvedValue({
      outcome: "paused",
      campaignId: CAMPAIGN_ID,
      workflowId: WORKFLOW_ID,
      status: "running",
    });
  });

  it.each([
    ["invalid campaign id", { workspaceId: WORKSPACE_ID, paused: true }, "bad"],
    ["invalid workspace id", { workspaceId: "invalid", paused: true }, CAMPAIGN_ID],
    [
      "unknown body fields",
      { workspaceId: WORKSPACE_ID, paused: true, workflowId: "attacker" },
      CAMPAIGN_ID,
    ],
    ["non-boolean paused", { workspaceId: WORKSPACE_ID, paused: "yes" }, CAMPAIGN_ID],
  ])("strictly rejects %s", async (_label, body, campaignId) => {
    const response = await POST(request(body), context(campaignId));

    expect(response.status).toBe(400);
    expect(mockSignalBulkCampaignDispatchPause).not.toHaveBeenCalled();
    expect(mockSetCampaignDispatchPaused).not.toHaveBeenCalled();
  });

  it("signals Temporal before writing the local pause marker", async () => {
    const response = await pause();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      campaignId: CAMPAIGN_ID,
      status: "running",
      paused: true,
      outcome: "paused",
    });
    expect(mockSignalBulkCampaignDispatchPause).toHaveBeenCalledWith({
      workflowId: WORKFLOW_ID,
      paused: true,
    });
    expect(mockSetCampaignDispatchPaused).toHaveBeenCalledWith({
      supabase: { kind: "service-role" },
      workspaceId: WORKSPACE_ID,
      campaignId: CAMPAIGN_ID,
      paused: true,
    });
    expect(mockSignalBulkCampaignDispatchPause.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetCampaignDispatchPaused.mock.invocationCallOrder[0]
    );
  });

  it("resumes an active paused dispatch", async () => {
    mockSignalBulkCampaignDispatchPause.mockResolvedValue({ paused: false });
    mockSetCampaignDispatchPaused.mockResolvedValue({
      outcome: "resumed",
      campaignId: CAMPAIGN_ID,
      workflowId: WORKFLOW_ID,
      status: "running",
    });

    const response = await POST(
      request({ workspaceId: WORKSPACE_ID, paused: false }),
      context()
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      campaignId: CAMPAIGN_ID,
      status: "running",
      paused: false,
      outcome: "resumed",
    });
  });

  it("does not write SQL when the workflow does not support pause", async () => {
    mockSignalBulkCampaignDispatchPause.mockRejectedValue(new Error("no query"));
    mockIsBulkCampaignPauseUnsupportedError.mockReturnValue(true);

    const response = await pause();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "workflow_pause_unsupported",
      error: "This campaign workflow does not support pause yet.",
      campaignId: CAMPAIGN_ID,
    });
    expect(mockSetCampaignDispatchPaused).not.toHaveBeenCalled();
  });

  it("does not write SQL when the workflow is already closed", async () => {
    mockSignalBulkCampaignDispatchPause.mockRejectedValue(
      new WorkflowNotFoundError("gone", WORKFLOW_ID, undefined)
    );

    const response = await pause();

    expect(response.status).toBe(409);
    expect(mockSetCampaignDispatchPaused).not.toHaveBeenCalled();
  });

  it("rejects terminal campaigns before Temporal", async () => {
    mockGetCampaignDispatchStatus.mockResolvedValue({
      campaignId: CAMPAIGN_ID,
      workspaceId: WORKSPACE_ID,
      workflowId: WORKFLOW_ID,
      status: "completed",
    });

    const response = await pause();

    expect(response.status).toBe(409);
    expect(mockSignalBulkCampaignDispatchPause).not.toHaveBeenCalled();
  });

  it.each([
    [401, "Unauthorized"],
    [403, "Forbidden"],
  ])("preserves membership authorization status %s", async (status, error) => {
    mockGetAuthenticatedWorkspaceMembership.mockResolvedValue({
      error: NextResponse.json({ error }, { status }),
    });

    const response = await pause();

    expect(response.status).toBe(status);
    expect(mockGetCampaignDispatchStatus).not.toHaveBeenCalled();
  });

  it("rejects non-manager roles", async () => {
    mockGetAuthenticatedWorkspaceMembership.mockResolvedValue(
      workspaceMembership("viewer")
    );

    const response = await pause();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      code: "forbidden",
      error: "Forbidden",
    });
    expect(mockSignalBulkCampaignDispatchPause).not.toHaveBeenCalled();
  });

  it("returns 404 when the campaign is missing", async () => {
    mockGetCampaignDispatchStatus.mockResolvedValue(null);

    const response = await pause();

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "campaign_not_found",
      error: "Campaign not found.",
    });
  });

  it.each([
    {
      title: "returns 502 when the workflow id is empty",
      arrange: () =>
        mockGetCampaignDispatchStatus.mockResolvedValue({
          campaignId: CAMPAIGN_ID,
          workspaceId: WORKSPACE_ID,
          workflowId: "",
          status: "running",
        }),
      status: 502,
      code: "temporal_pause_failed",
      notCalled: mockSignalBulkCampaignDispatchPause,
    },
    {
      title: "returns 502 when Temporal pause confirmation mismatches",
      arrange: () =>
        mockSignalBulkCampaignDispatchPause.mockResolvedValue({
          paused: false,
        }),
      status: 502,
      code: "temporal_pause_failed",
      notCalled: mockSetCampaignDispatchPaused,
    },
    {
      title: "returns 502 on a generic Temporal error",
      arrange: () =>
        mockSignalBulkCampaignDispatchPause.mockRejectedValue(
          new Error("temporal unavailable")
        ),
      status: 502,
      code: "temporal_pause_failed",
      notCalled: undefined,
    },
    {
      title: "returns 503 when the local status load fails",
      arrange: () =>
        mockGetCampaignDispatchStatus.mockRejectedValue(new Error("db down")),
      status: 503,
      code: "campaign_pause_failed",
      notCalled: undefined,
    },
    {
      title: "returns 503 when the local pause write fails",
      arrange: () =>
        mockSetCampaignDispatchPaused.mockRejectedValue(new Error("db write")),
      status: 503,
      code: "campaign_pause_failed",
      notCalled: undefined,
    },
  ])("$title", async ({ arrange, status, code, notCalled }) => {
    arrange();

    const response = await pause();

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ code, retryable: true })
    );
    if (notCalled) expect(notCalled).not.toHaveBeenCalled();
  });
});
