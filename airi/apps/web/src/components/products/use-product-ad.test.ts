/** @jest-environment jsdom */
import type { ProductAdRecord } from "@/lib/products/types";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { SWRConfig } from "swr";
import { fetchProductAd } from "./ads-client";
import { PRODUCT_AD_POLL_MS, useProductAd } from "./use-product-ad";

jest.mock("./ads-client", () => ({
  ...jest.requireActual("./ads-client"),
  fetchProductAd: jest.fn(),
}));

// The studio asks for an ad every 2 s while it's being made: opened from
// the made list or a reload, with nothing cached, and once Try again or an
// edit answers with the ad making again.

const swr = ({ children }: { children: ReactNode }) =>
  createElement(
    SWRConfig,
    { value: { provider: () => new Map(), dedupingInterval: 0 } },
    children
  );

const ad = (status: ProductAdRecord["status"]) =>
  ({ id: "ad-1", status }) as ProductAdRecord;

/** Runs the clock half a second at a time; when (ms) the ad was asked for. */
async function askedAt(until: number): Promise<number[]> {
  const fetcher = jest.mocked(fetchProductAd);
  const at: number[] = [];
  const before = fetcher.mock.calls.length;
  for (let now = 500; now <= until; now += 500) {
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    while (before + at.length < fetcher.mock.calls.length) at.push(now);
  }
  return at;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.mocked(fetchProductAd).mockReset();
});
afterEach(() => jest.useRealTimers());

test("asks for an ad being made every 2 s when it's opened with nothing cached", async () => {
  jest.mocked(fetchProductAd).mockResolvedValue(ad("making"));
  renderHook(() => useProductAd("workspace-1", "ad-1"), { wrapper: swr });
  await act(async () => {});
  expect(fetchProductAd).toHaveBeenCalledTimes(1);

  expect(await askedAt(5_000)).toEqual([
    PRODUCT_AD_POLL_MS,
    2 * PRODUCT_AD_POLL_MS,
  ]);
});

test("starts asking again once Try again answers with the ad being made", async () => {
  jest.mocked(fetchProductAd).mockResolvedValue(ad("failed"));
  const { result } = renderHook(() => useProductAd("workspace-1", "ad-1"), {
    wrapper: swr,
  });
  await act(async () => {});
  expect(await askedAt(10_000)).toEqual([]);

  jest.mocked(fetchProductAd).mockResolvedValue(ad("making"));
  await act(async () => {
    await result.current.mutate(ad("making"), { revalidate: false });
  });

  expect(await askedAt(5_000)).toEqual([
    PRODUCT_AD_POLL_MS,
    2 * PRODUCT_AD_POLL_MS,
  ]);
});
