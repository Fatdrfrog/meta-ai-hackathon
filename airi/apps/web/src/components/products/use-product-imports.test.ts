/** @jest-environment jsdom */
import type { ProductVideoImportsResponse } from "@/lib/products/types";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { SWRConfig } from "swr";
import { fetchProductImports } from "./products-client";
import {
  PRODUCT_IMPORT_POLL_MS,
  useProductImports,
} from "./use-product-imports";

jest.mock("@/hooks/use-realtime", () => ({
  useRealtime: () => ({ channel: null, isConnected: false }),
}));
jest.mock("./products-client", () => ({
  ...jest.requireActual("./products-client"),
  fetchProductImports: jest.fn(),
}));

// The page asks for its imports again on its own while one runs, in case a
// realtime step was lost. SWR starts that wait over whenever refreshInterval
// changes, and the page re-renders on its other polls and events.

const swr = ({ children }: { children: ReactNode }) =>
  createElement(
    SWRConfig,
    { value: { provider: () => new Map(), dedupingInterval: 0 } },
    children
  );

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("asks for the imports every 10 s while one runs, however often the page re-renders", async () => {
  jest.mocked(fetchProductImports).mockResolvedValue({
    imports: [{ id: "import-1", status: "processing" }],
  } as unknown as ProductVideoImportsResponse);
  const { rerender } = renderHook(() => useProductImports("workspace-1"), {
    wrapper: swr,
  });
  // Asked for once on the way in.
  await act(async () => {});
  const at: number[] = jest.mocked(fetchProductImports).mock.calls.map(() => 0);

  for (let now = 1_000; now <= 25_000; now += 1_000) {
    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
    if (now % 4_000 === 0) rerender();
    while (at.length < jest.mocked(fetchProductImports).mock.calls.length)
      at.push(now);
  }

  expect(at).toEqual([0, PRODUCT_IMPORT_POLL_MS, 2 * PRODUCT_IMPORT_POLL_MS]);
});
