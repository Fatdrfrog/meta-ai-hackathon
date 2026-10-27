/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import {
  GENERATED_ASSET_MAX_POLL_DURATION_MS,
  GENERATED_ASSET_MAX_TRANSIENT_FAILURES,
  GENERATED_ASSET_POLL_INTERVAL_MS,
  useGeneratedCreativeAsset,
  type GeneratedCreativeAssetView,
} from "./use-generated-creative-asset";

function AssetCommitProbe({
  assetId,
  onCommit,
}: {
  assetId: string | null;
  onCommit: (asset: GeneratedCreativeAssetView | null) => void;
}) {
  const asset = useGeneratedCreativeAsset("workspace-1", assetId);

  useLayoutEffect(() => {
    onCommit(asset);
  });

  return null;
}

describe("useGeneratedCreativeAsset", () => {
  it("never commits an asset resolved for a previous request key", async () => {
    const onCommit = jest.fn();
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          asset: {
            id: "asset-1",
            status: "complete",
            url: "https://cdn.example.com/asset-1.png",
          },
        }),
      })
      .mockImplementation(() => new Promise(() => undefined)) as jest.Mock;

    const view = render(
      <AssetCommitProbe assetId="asset-1" onCommit={onCommit} />
    );

    await waitFor(() =>
      expect(onCommit).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "asset-1", status: "complete" })
      )
    );

    onCommit.mockClear();
    view.rerender(<AssetCommitProbe assetId="asset-2" onCommit={onCommit} />);

    expect(onCommit.mock.calls.map(([asset]) => asset)).toEqual([null]);

    onCommit.mockClear();
    view.rerender(<AssetCommitProbe assetId="asset-1" onCommit={onCommit} />);

    expect(onCommit.mock.calls.map(([asset]) => asset)).toEqual([null]);
    view.unmount();
  });

  describe("polling", () => {
    const fetchMock = jest.fn();

    function assetResponse(status: string, extra?: Record<string, unknown>) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ asset: { id: "asset-1", status, ...extra } }),
      };
    }

    function errorResponse(status: number) {
      return { ok: false, status, json: async () => ({}) };
    }

    function AssetStatus({ label }: { label: string }) {
      const asset = useGeneratedCreativeAsset("workspace-1", "asset-1");
      return (
        <p data-testid={label}>
          {asset ? `${asset.status}:${asset.error ?? asset.url ?? ""}` : "none"}
        </p>
      );
    }

    async function advance(ms: number) {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(ms);
      });
    }

    beforeEach(() => {
      jest.useFakeTimers();
      fetchMock.mockReset();
      global.fetch = fetchMock as jest.Mock;
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("retries a 5xx, a 429 and a network error instead of failing", async () => {
      fetchMock
        .mockResolvedValueOnce(assetResponse("queued"))
        .mockResolvedValueOnce(errorResponse(503))
        .mockResolvedValueOnce(errorResponse(429))
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce(
          assetResponse("complete", { url: "https://cdn.example/a.png" })
        );

      const view = render(<AssetStatus label="card" />);
      await advance(0);
      expect(screen.getByTestId("card")).toHaveTextContent("queued:");

      // 3 s poll -> 503, then backoff 6 s -> 429, 12 s -> network, 24 s -> done.
      await advance(GENERATED_ASSET_POLL_INTERVAL_MS);
      expect(screen.getByTestId("card")).toHaveTextContent("queued:");
      await advance(6_000);
      expect(screen.getByTestId("card")).toHaveTextContent("queued:");
      await advance(12_000);
      expect(screen.getByTestId("card")).toHaveTextContent("queued:");
      await advance(24_000);

      expect(screen.getByTestId("card")).toHaveTextContent(
        "complete:https://cdn.example/a.png"
      );
      expect(fetchMock).toHaveBeenCalledTimes(5);
      await advance(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(5);
      view.unmount();
    });

    it("fails only after repeated transient errors", async () => {
      fetchMock.mockResolvedValue(errorResponse(502));

      const view = render(<AssetStatus label="card" />);
      await advance(0);
      // Backoff doubles from the poll interval: 6 s, 12 s, 24 s, then 30 s.
      for (const delay of [6_000, 12_000, 24_000]) {
        expect(screen.getByTestId("card")).toHaveTextContent("none");
        await advance(delay);
      }
      expect(fetchMock).toHaveBeenCalledTimes(
        GENERATED_ASSET_MAX_TRANSIENT_FAILURES - 1
      );
      expect(screen.getByTestId("card")).toHaveTextContent("none");
      await advance(30_000);

      expect(screen.getByTestId("card")).toHaveTextContent(
        "failed:Asset refresh failed: 502"
      );
      expect(fetchMock).toHaveBeenCalledTimes(
        GENERATED_ASSET_MAX_TRANSIENT_FAILURES
      );
      await advance(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(
        GENERATED_ASSET_MAX_TRANSIENT_FAILURES
      );
      view.unmount();
    });

    it("shares one poller between cards showing the same asset", async () => {
      fetchMock.mockResolvedValue(assetResponse("in_progress"));

      const view = render(
        <>
          <AssetStatus label="first" />
          <AssetStatus label="second" />
        </>
      );
      await advance(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await advance(GENERATED_ASSET_POLL_INTERVAL_MS);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("first")).toHaveTextContent("in_progress:");
      expect(screen.getByTestId("second")).toHaveTextContent("in_progress:");

      view.unmount();
      await advance(GENERATED_ASSET_POLL_INTERVAL_MS * 3);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("stops polling a generation that never finishes", async () => {
      fetchMock.mockResolvedValue(assetResponse("queued"));

      const view = render(<AssetStatus label="card" />);
      await advance(GENERATED_ASSET_MAX_POLL_DURATION_MS);

      expect(screen.getByTestId("card")).toHaveTextContent(
        "failed:Generation is taking longer than expected"
      );
      const calls = fetchMock.mock.calls.length;
      expect(calls).toBeLessThanOrEqual(
        GENERATED_ASSET_MAX_POLL_DURATION_MS /
          GENERATED_ASSET_POLL_INTERVAL_MS +
          1
      );
      await advance(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(calls);
      view.unmount();
    });
  });
});
