/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react";
import {
  BULK_CAMPAIGN_STATUS_POLL_INTERVAL_MS,
  BULK_CAMPAIGN_DELIVERY_POLL_INTERVAL_MS,
  getBulkCampaignStatusRefreshInterval,
  useBulkCampaignDispatchStatus,
  useBulkCampaignRealtime,
  retryCampaignStatusError,
} from "./use-bulk-campaign-dispatch-status";
import type { RealtimeEventEnvelope } from "@icecore/shared/types/realtime";

const mockUseSWR = jest.fn();
const mockUseRealtime = jest.fn();
jest.mock("@/hooks/use-realtime", () => ({
  useRealtime: (...args: unknown[]) => mockUseRealtime(...args),
}));

jest.mock("swr", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockUseSWR(...args),
}));

function makeSWRState(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    data: undefined,
    error: undefined,
    isLoading: false,
    mutate: jest.fn(async () => undefined),
    ...overrides,
  };
}

function campaignDeliveryEvent(
  workspaceId: string,
  campaignId: string
): RealtimeEventEnvelope {
  return {
    eventId: "event-1",
    version: 1,
    name: "campaign.delivery.changed",
    createdAt: "2026-09-15T10:55:00.000Z",
    dedupeKey: "campaign-status-1",
    workspaceId,
    payload: { campaignId },
  };
}

describe("useBulkCampaignDispatchStatus", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockUseSWR.mockReset();
    mockUseSWR.mockReturnValue(makeSWRState());
    mockUseRealtime.mockReturnValue({ channel: null, isConnected: false });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it("uses a slower delivery refresh after dispatch finishes", () => {
    expect(getBulkCampaignStatusRefreshInterval("queued")).toBe(
      BULK_CAMPAIGN_STATUS_POLL_INTERVAL_MS
    );
    expect(getBulkCampaignStatusRefreshInterval("scheduled")).toBe(
      BULK_CAMPAIGN_STATUS_POLL_INTERVAL_MS
    );
    expect(getBulkCampaignStatusRefreshInterval("running")).toBe(
      BULK_CAMPAIGN_STATUS_POLL_INTERVAL_MS
    );
    for (const status of [
      "completed",
      "failed",
      "cancelled",
      "expired",
    ] as const) {
      expect(getBulkCampaignStatusRefreshInterval(status)).toBe(
        BULK_CAMPAIGN_DELIVERY_POLL_INTERVAL_MS
      );
    }
    expect(getBulkCampaignStatusRefreshInterval(null)).toBe(0);
  });

  it("loads delivery results for terminal dispatches", () => {
    renderHook(() =>
      useBulkCampaignDispatchStatus({
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        initialStatus: "completed",
      })
    );

    expect(mockUseSWR.mock.calls.at(-1)?.[0]).toContain(
      "/api/campaigns/campaign-1/status"
    );
  });

  it("keeps status recovery enabled after transient request errors", () => {
    const { result, rerender } = renderHook(() =>
      useBulkCampaignDispatchStatus({
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        initialStatus: "running",
      })
    );
    const options = mockUseSWR.mock.calls.at(-1)?.[2] as {
      shouldRetryOnError: (error: Error & { status?: number }) => boolean;
      revalidateOnFocus: boolean;
      revalidateOnReconnect: boolean;
      onErrorRetry: typeof retryCampaignStatusError;
    };

    expect(mockUseSWR.mock.calls.at(-1)?.[0]).toContain(
      "/api/campaigns/campaign-1/status"
    );
    expect(options.shouldRetryOnError(new Error("temporarily offline"))).toBe(
      true
    );
    expect(
      options.shouldRetryOnError(
        Object.assign(new Error("forbidden"), { status: 403 })
      )
    ).toBe(false);
    expect(options.onErrorRetry).toBe(retryCampaignStatusError);
    expect(options.revalidateOnFocus).toBe(true);
    expect(options.revalidateOnReconnect).toBe(true);
    mockUseSWR.mockReturnValue(
      makeSWRState({ error: new Error("temporarily offline") })
    );
    rerender();

    expect(mockUseSWR.mock.calls.at(-1)?.[0]).toContain(
      "/api/campaigns/campaign-1/status"
    );
    expect(result.current.error?.message).toBe("temporarily offline");
  });

  it("ignores other campaigns and cancels queued refreshes when the workspace changes", () => {
    jest.useFakeTimers();
    let handler!: (event: RealtimeEventEnvelope) => void;
    const channel = {
      bind: jest.fn((_name, callback) => {
        handler = callback;
      }),
      unbind: jest.fn(),
    };
    mockUseRealtime.mockReturnValue({ channel, isConnected: false });
    const onChange = jest.fn();
    const { rerender, unmount } = renderHook(
      ({ workspaceId }) =>
        useBulkCampaignRealtime({
          workspaceId,
          campaignId: "campaign-1",
          onChange,
        }),
      { initialProps: { workspaceId: "workspace-1" } }
    );
    act(() => {
      handler(campaignDeliveryEvent("workspace-1", "campaign-2"));
      handler(campaignDeliveryEvent("workspace-2", "campaign-1"));
      jest.advanceTimersByTime(500);
    });
    expect(onChange).not.toHaveBeenCalled();
    act(() => handler(campaignDeliveryEvent("workspace-1", "campaign-1")));
    rerender({ workspaceId: "workspace-2" });
    act(() => jest.advanceTimersByTime(500));
    expect(onChange).not.toHaveBeenCalled();
    expect(channel.unbind).toHaveBeenCalledTimes(1);
    act(() => {
      handler(campaignDeliveryEvent("workspace-2", "campaign-1"));
      jest.advanceTimersByTime(500);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    unmount();
    expect(channel.unbind).toHaveBeenCalledTimes(2);
  });

  it("cancels an active dispatch and transitions it locally", async () => {
    const mutate = jest.fn(async () => undefined);
    mockUseSWR.mockReturnValue(makeSWRState({ mutate }));
    global.fetch = jest.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({
            campaignId: "campaign-1",
            status: "cancelled",
            outcome: "cancelled",
            temporalCancellation: "cancelled",
          }),
        }) as Response
    ) as jest.Mock;
    const { result } = renderHook(() =>
      useBulkCampaignDispatchStatus({
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        initialStatus: "queued",
      })
    );

    await act(async () => {
      await expect(result.current.cancel()).resolves.toBe(true);
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/campaigns/campaign-1/cancel",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ workspaceId: "workspace-1" }),
      })
    );
    expect(result.current.status).toBe("cancelled");
    expect(result.current.isPolling).toBe(false);
    expect(mutate).toHaveBeenCalled();
  });

  it("shows pause controls from the local pause before status has loaded", async () => {
    const mutate = jest.fn(async () => undefined);
    mockUseSWR.mockReturnValue(makeSWRState({ mutate, data: undefined }));
    global.fetch = jest.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({
            campaignId: "campaign-1",
            status: "running",
            paused: true,
            outcome: "paused",
          }),
        }) as Response
    ) as jest.Mock;
    const { result } = renderHook(() =>
      useBulkCampaignDispatchStatus({
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        initialStatus: "running",
      })
    );

    await act(async () => {
      await expect(result.current.setPaused(true)).resolves.toBe(true);
    });

    expect(result.current.operation?.paused).toBe(true);
    expect(mutate).toHaveBeenCalled();
  });

  it("pauses an active dispatch through the pause route", async () => {
    const mutate = jest.fn(async () => undefined);
    mockUseSWR.mockReturnValue(
      makeSWRState({
        mutate,
        data: {
          status: "running",
          canCancel: true,
          paused: false,
        },
      })
    );
    global.fetch = jest.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({
            campaignId: "campaign-1",
            status: "running",
            paused: true,
            outcome: "paused",
          }),
        }) as Response
    ) as jest.Mock;
    const { result } = renderHook(() =>
      useBulkCampaignDispatchStatus({
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        initialStatus: "running",
      })
    );

    await act(async () => {
      await expect(result.current.setPaused(true)).resolves.toBe(true);
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/campaigns/campaign-1/pause",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ workspaceId: "workspace-1", paused: true }),
      })
    );
    expect(result.current.operation?.paused).toBe(true);
    expect(mutate).toHaveBeenCalled();
  });

  it("keeps the local cancellation visible when Temporal confirmation fails", async () => {
    mockUseSWR.mockReturnValue(makeSWRState());
    global.fetch = jest.fn(
      async () =>
        ({
          ok: false,
          status: 502,
          json: async () => ({
            status: "cancelled",
            error:
              "Campaign was cancelled locally, but workflow cancellation could not be confirmed.",
          }),
        }) as Response
    ) as jest.Mock;
    const { result } = renderHook(() =>
      useBulkCampaignDispatchStatus({
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        initialStatus: "running",
      })
    );

    await act(async () => {
      await expect(result.current.cancel()).resolves.toBe(true);
    });

    expect(result.current.status).toBe("cancelled");
    expect(result.current.cancelError).toContain(
      "workflow cancellation could not be confirmed"
    );
  });
});
