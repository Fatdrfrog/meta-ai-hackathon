/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CampaignOperationStatusResponse } from "@/lib/campaign/campaign-operations-contracts";
import {
  CampaignDispatchLiveStatus,
  CampaignDispatchPlanLiveStatus,
  type CampaignDispatchLiveStatusLabels,
} from "./campaign-dispatch-live-status";
import { useBulkCampaignDispatchStatus } from "./use-bulk-campaign-dispatch-status";

jest.mock("./use-bulk-campaign-dispatch-status", () => ({
  useBulkCampaignDispatchStatus: jest.fn(),
}));

const mockTranslateCalls: unknown[][] = [];

jest.mock("next-intl", () => ({
  useTranslations:
    (namespace?: string) => (key: string, values?: Record<string, unknown>) => {
      mockTranslateCalls.push([namespace, key, values]);
      return key;
    },
}));

const mockUseBulkCampaignDispatchStatus =
  useBulkCampaignDispatchStatus as jest.MockedFunction<
    typeof useBulkCampaignDispatchStatus
  >;

const labels: CampaignDispatchLiveStatusLabels = {
  lifecycleStatus: status => `Status: ${status}`,
  attempted: (attempted, total) => `${attempted}/${total} sent`,
  accepted: count => `${count} accepted`,
  delivered: count => `${count} delivered`,
  read: count => `${count} read`,
  failed: count => `${count} failed`,
  cancel: "Cancel campaign",
  cancelling: "Cancelling...",
  pause: "Pause",
  pausing: "Pausing...",
  resume: "Resume",
  resuming: "Resuming...",
  paused: "Paused",
  statusUnavailable: message => `Status unavailable: ${message}`,
  cancelFailed: message => `Cancellation warning: ${message}`,
  pauseFailed: message => `Pause warning: ${message}`,
};

function makeOperation(
  overrides: Partial<CampaignOperationStatusResponse> = {}
): CampaignOperationStatusResponse {
  return {
    campaignId: "campaign-1",
    status: "running",
    requestedAt: null,
    scheduledAt: null,
    dispatchExpiresAt: null,
    startedAt: null,
    progressAt: null,
    finishedAt: null,
    cancelledAt: null,
    expiredAt: null,
    totalRecipients: 10,
    progress: {
      processed: 4,
      accepted: 3,
      attempted: 4,
      notAttempted: 6,
      successful: 3,
      failed: 1,
    },
    delivery: {
      pending: 1,
      accepted: 3,
      delivered: 2,
      read: 1,
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
      failedRecipientCount: 0,
      available: false,
    },
    canCancel: true,
    paused: false,
    ...overrides,
  };
}

function mockStatus(
  overrides: Partial<ReturnType<typeof useBulkCampaignDispatchStatus>> = {}
) {
  mockUseBulkCampaignDispatchStatus.mockReturnValue({
    operation: makeOperation(),
    status: "running",
    error: null,
    isLoading: false,
    isPolling: true,
    cancel: jest.fn(async () => true),
    cancelError: null,
    isCancelling: false,
    setPaused: jest.fn(async () => true),
    pauseError: null,
    isUpdatingPause: false,
    mutate: jest.fn(),
    ...overrides,
  });
}

describe("CampaignDispatchLiveStatus", () => {
  beforeEach(() => {
    mockUseBulkCampaignDispatchStatus.mockReset();
    mockStatus();
  });

  it("shows live counts and lets an active campaign be cancelled", async () => {
    const cancel = jest.fn(async () => true);
    mockStatus({ cancel });

    render(
      <CampaignDispatchLiveStatus
        workspaceId="workspace-1"
        campaignId="campaign-1"
        initialStatus="running"
        labels={labels}
      />
    );

    expect(screen.getByText("4/10 sent")).toBeTruthy();
    // Funnel: accepted includes delivered and read, delivered includes read.
    expect(screen.getByText("6 accepted")).toBeTruthy();
    expect(screen.getByText("3 delivered")).toBeTruthy();
    expect(screen.getByText("1 read")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel campaign" }));

    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });

  it("counts a stopped run by messages sent, not by the batch it skipped", () => {
    // A dealer workspace 2026-10-23: Meta 131042 opened the circuit after 20 sends;
    // the worker marked the next batch of 20 processed without sending it.
    mockStatus({
      status: "failed",
      operation: makeOperation({
        status: "failed",
        totalRecipients: 500,
        progress: {
          processed: 40,
          accepted: 20,
          attempted: 20,
          notAttempted: 480,
          successful: 17,
          failed: 3,
        },
        delivery: {
          pending: 0,
          accepted: 0,
          delivered: 17,
          read: 0,
          failed: 3,
        },
        canCancel: false,
      }),
    });

    render(
      <CampaignDispatchLiveStatus
        workspaceId="workspace-1"
        campaignId="campaign-1"
        initialStatus="failed"
        labels={labels}
      />
    );

    expect(screen.getByText("20/500 sent")).toBeTruthy();
    expect(screen.getByText("17 accepted")).toBeTruthy();
    expect(screen.getByText("17 delivered")).toBeTruthy();
    expect(screen.getByText("3 failed")).toBeTruthy();
  });

  it("pauses an active campaign from live status", async () => {
    const setPaused = jest.fn(async () => true);
    mockStatus({ setPaused });

    render(
      <CampaignDispatchLiveStatus
        workspaceId="workspace-1"
        campaignId="campaign-1"
        initialStatus="running"
        labels={labels}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(setPaused).toHaveBeenCalledWith(true));
  });

  it("provides campaign-builder translations for the plan-card wrapper", () => {
    render(
      <CampaignDispatchPlanLiveStatus
        workspaceId="workspace-1"
        campaignId="campaign-1"
        initialStatus="running"
      />
    );

    expect(screen.getByText("dispatchLifecycleStatus")).toBeTruthy();
    // The status is a translated word, not the raw value like "running".
    expect(mockTranslateCalls).toContainEqual([
      "CampaignDispatchPlanCard",
      "lifecycleStatus",
      { status: "running" },
    ]);
    expect(mockTranslateCalls).toContainEqual([
      "MultiChannelCampaignBuilder",
      "dispatchLifecycleStatus",
      { status: "lifecycleStatus" },
    ]);
    expect(screen.getByRole("button", { name: "pauseDispatch" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "cancelDispatch" })).toBeTruthy();
  });

  it("hides cancel for terminal campaigns and reports the lifecycle transition once", async () => {
    const onLifecycleChange = jest.fn();
    mockStatus({
      operation: makeOperation({ status: "completed", canCancel: false }),
      status: "completed",
      isPolling: false,
    });

    const { rerender } = render(
      <CampaignDispatchLiveStatus
        workspaceId="workspace-1"
        campaignId="campaign-1"
        initialStatus="running"
        labels={labels}
        onLifecycleChange={onLifecycleChange}
      />
    );

    expect(
      screen.queryByRole("button", { name: "Cancel campaign" })
    ).toBeNull();
    await waitFor(() =>
      expect(onLifecycleChange).toHaveBeenCalledWith(
        "completed",
        expect.objectContaining({ status: "completed" })
      )
    );

    rerender(
      <CampaignDispatchLiveStatus
        workspaceId="workspace-1"
        campaignId="campaign-1"
        initialStatus="running"
        labels={labels}
        onLifecycleChange={onLifecycleChange}
      />
    );
    expect(onLifecycleChange).toHaveBeenCalledTimes(1);
  });

  it("shows polling and cancellation errors without hiding a committed cancellation", () => {
    mockStatus({
      operation: makeOperation({ status: "cancelled", canCancel: false }),
      status: "cancelled",
      error: new Error("status route unavailable"),
      cancelError: "workflow cancellation could not be confirmed",
      isPolling: false,
    });

    render(
      <CampaignDispatchLiveStatus
        workspaceId="workspace-1"
        campaignId="campaign-1"
        initialStatus="running"
        labels={labels}
      />
    );

    expect(screen.getByText("Status: cancelled")).toBeTruthy();
    expect(
      screen.getByText("Status unavailable: status route unavailable")
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Cancellation warning: workflow cancellation could not be confirmed"
      )
    ).toBeTruthy();
  });
});
