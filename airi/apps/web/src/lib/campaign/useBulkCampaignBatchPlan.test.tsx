/**
 * @jest-environment jsdom
 */

import { act, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { useBulkCampaignBatchPlanPreview } from "./useBulkCampaignBatchPlan";

// SWR's own defaults (focus, reconnect and error retries on), as in the app.
function swrWrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {children}
    </SWRConfig>
  );
}

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

const params = {
  workspaceId: "00000000-0000-4000-8000-000000000601",
  channel: "whatsapp" as const,
  sourceId: "source-1",
};

describe("useBulkCampaignBatchPlanPreview", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it("does not retry a failed plan or re-check it on focus or reconnect", async () => {
    jest.useFakeTimers({ now: new Date("2026-10-05T10:00:00Z") });
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ error: "Unknown error" }, 500));
    const { result } = renderHook(
      () => useBulkCampaignBatchPlanPreview(params),
      { wrapper: swrWrapper }
    );
    await waitFor(() => expect(result.current.error).toBeDefined());

    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("online"));
      await jest.advanceTimersByTimeAsync(1_000);
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result.current.preview).toEqual({
      configured: false,
      channel: "whatsapp",
      error: "Unknown error",
    });

    await act(async () => {
      result.current.refresh();
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("reuses a plan from the last minute when it remounts", async () => {
    jest.useFakeTimers({ now: new Date("2026-10-05T10:00:00Z") });
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        jsonResponse({ configured: true, channel: "whatsapp" })
      );
    // The provider stays mounted, like the app's global cache.
    const resultRef: {
      current: ReturnType<typeof useBulkCampaignBatchPlanPreview> | null;
    } = { current: null };
    const report = (
      state: ReturnType<typeof useBulkCampaignBatchPlanPreview>
    ) => {
      resultRef.current = state;
    };
    function Probe() {
      report(useBulkCampaignBatchPlanPreview(params));
      return null;
    }
    const cache = new Map();
    const tree = (mounted: boolean) => (
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
        {mounted ? <Probe /> : null}
      </SWRConfig>
    );
    const view = render(tree(true));
    await waitFor(() => expect(resultRef.current?.preview).not.toBeNull());
    view.rerender(tree(false));

    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    view.rerender(tree(true));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_000);
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(resultRef.current?.preview).toEqual({
      configured: true,
      channel: "whatsapp",
    });
  });

  it("does not re-check a loaded plan on window focus", async () => {
    jest.useFakeTimers({ now: new Date("2026-10-05T10:00:00Z") });
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        jsonResponse({ configured: true, channel: "whatsapp" })
      );
    const { result } = renderHook(
      () => useBulkCampaignBatchPlanPreview(params),
      { wrapper: swrWrapper }
    );
    await waitFor(() => expect(result.current.preview).not.toBeNull());

    await act(async () => {
      await jest.advanceTimersByTimeAsync(6_000);
      window.dispatchEvent(new Event("focus"));
      await jest.advanceTimersByTimeAsync(1_000);
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result.current.isRefreshing).toBe(false);
  });
});
