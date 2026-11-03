/** @jest-environment jsdom */
import type {
  ProductKitPlanResponse,
  ProductKitRecord,
  ProductsMadeResponse,
} from "@/lib/products/types";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { SWRConfig } from "swr";
import {
  fetchProductKit,
  fetchProductKitPlan,
  fetchProductsMade,
} from "./kits-client";
import {
  formatElapsed,
  KIT_MAKING_POLL_MS,
  KIT_WAITING_POLL_MS,
  kitPollMs,
  MADE_MAKING_POLL_MS,
  madePollMs,
  madeWhen,
  PLAN_MISSING_POLL_MS,
  useProductKit,
  useProductKitPlan,
  useProductsMade,
} from "./use-product-kits";

jest.mock("./kits-client", () => ({
  ...jest.requireActual("./kits-client"),
  fetchProductKit: jest.fn(),
  fetchProductKitPlan: jest.fn(),
  fetchProductsMade: jest.fn(),
}));

// How often a kit and the made list are asked for, and how times read.

const kit = (status: ProductKitRecord["status"]) =>
  ({ status }) as ProductKitRecord;
const made = (
  kits: ProductKitRecord[],
  adStatus?: "making" | "ready"
): ProductsMadeResponse => ({
  kits,
  ads: adStatus
    ? [{ status: adStatus } as ProductsMadeResponse["ads"][number]]
    : [],
  whatsapp: { connected: true, displayPhone: null },
});

test("a kit is asked for often while made, now and then while Meta checks it, and not once settled", () => {
  expect(kitPollMs(kit("making"))).toBe(KIT_MAKING_POLL_MS);
  expect(kitPollMs(kit("waiting_for_meta"))).toBe(KIT_WAITING_POLL_MS);
  expect(kitPollMs(kit("ready"))).toBe(0);
  expect(kitPollMs(kit("needs_attention"))).toBe(0);
  expect(kitPollMs(undefined)).toBe(0);
});

test("a kit whose order form failed is asked for while Meta still checks its carousel", () => {
  // Needs attention for the form, but the carousel row says it updates itself.
  const withCarousel = (metaStatus: string) =>
    ({
      status: "needs_attention",
      parts: {
        orderForm: {
          state: "failed",
          flowId: null,
          flowName: null,
          productCount: 3,
          error: { code: "meta_refused", message: "Flow refused" },
        },
        carousel: {
          state: "submitted",
          templateId: "tpl-1",
          templateName: "products_20261102_041405",
          cardCount: 3,
          metaStatus,
          metaReason: null,
          approvedAt: null,
          error: null,
        },
      },
    }) as ProductKitRecord;
  expect(kitPollMs(withCarousel("PENDING"))).toBe(KIT_WAITING_POLL_MS);
  expect(madePollMs(made([withCarousel("PENDING")]))).toBe(KIT_WAITING_POLL_MS);
  // Meta decided: nothing will change on its own.
  expect(kitPollMs(withCarousel("REJECTED"))).toBe(0);
  expect(madePollMs(made([withCarousel("REJECTED")]))).toBe(0);
});

test("the made list is asked for while a kit is made, Meta checks a carousel or an ad is made", () => {
  expect(madePollMs(made([kit("making")]))).toBe(MADE_MAKING_POLL_MS);
  expect(madePollMs(made([kit("waiting_for_meta")]))).toBe(KIT_WAITING_POLL_MS);
  expect(madePollMs(made([kit("ready")], "making"))).toBe(KIT_WAITING_POLL_MS);
  expect(madePollMs(made([kit("ready")], "ready"))).toBe(0);
  expect(madePollMs(undefined)).toBe(0);
});

describe("asking again while the page re-renders", () => {
  // SWR starts its wait over whenever refreshInterval changes. The Products
  // page re-renders on its own polls and events, more often than a kit's
  // 30 s: the card must still be asked for on time.
  const swr = ({ children }: { children: ReactNode }) =>
    createElement(
      SWRConfig,
      { value: { provider: () => new Map(), dedupingInterval: 0 } },
      children
    );

  /** Runs the clock, re-rendering the page now and then; when (ms) `fetcher` was called. */
  async function askedAt(
    fetcher: jest.Mock,
    rerender: () => void,
    clock: { until: number; step: number; rerenderEvery: number }
  ): Promise<number[]> {
    const at: number[] = fetcher.mock.calls.map(() => 0);
    for (let now = clock.step; now <= clock.until; now += clock.step) {
      await act(async () => {
        jest.advanceTimersByTime(clock.step);
      });
      if (now % clock.rerenderEvery === 0) rerender();
      while (at.length < fetcher.mock.calls.length) at.push(now);
    }
    return at;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.mocked(fetchProductKit).mockReset();
    jest.mocked(fetchProductKitPlan).mockReset();
    jest.mocked(fetchProductsMade).mockReset();
  });
  afterEach(() => jest.useRealTimers());

  it("asks for a kit Meta checks every 30 s, however often the page re-renders", async () => {
    const waiting = {
      id: "kit-1",
      status: "waiting_for_meta",
    } as ProductKitRecord;
    jest.mocked(fetchProductKit).mockResolvedValue(waiting);
    const { rerender } = renderHook(
      () => useProductKit("workspace-1", waiting),
      { wrapper: swr }
    );

    const at = await askedAt(jest.mocked(fetchProductKit), rerender, {
      until: 65_000,
      step: 1_000,
      rerenderEvery: 10_000,
    });

    expect(at).toEqual([KIT_WAITING_POLL_MS, 2 * KIT_WAITING_POLL_MS]);
  });

  it("starts asking for a kit every 2 s once a part's Try again makes it again", async () => {
    // Nothing to wait for: its order form failed, Meta approved the carousel.
    const stopped = {
      id: "kit-1",
      status: "needs_attention",
    } as ProductKitRecord;
    const making = { ...stopped, status: "making" } as ProductKitRecord;
    jest.mocked(fetchProductKit).mockResolvedValue(making);
    const { result, rerender } = renderHook(
      () => useProductKit("workspace-1", stopped),
      { wrapper: swr }
    );
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(fetchProductKit).not.toHaveBeenCalled();

    // The retry answers with the kit as it now is.
    await act(async () => {
      await result.current.mutate(making, { revalidate: false });
    });
    const at = await askedAt(jest.mocked(fetchProductKit), rerender, {
      until: 5_000,
      step: 500,
      rerenderEvery: 1_000,
    });

    expect(at).toEqual([KIT_MAKING_POLL_MS, 2 * KIT_MAKING_POLL_MS]);
  });

  it("asks for a plan still missing products every 1.5 s, however often the page re-renders", async () => {
    jest.mocked(fetchProductKitPlan).mockResolvedValue({
      products: [{ id: "p1" }],
    } as unknown as ProductKitPlanResponse);
    const { rerender } = renderHook(
      () => useProductKitPlan("workspace-1", ["p1", "p2"], null),
      { wrapper: swr }
    );
    // Asked for once on the way in.
    await act(async () => {});

    const at = await askedAt(jest.mocked(fetchProductKitPlan), rerender, {
      until: 12_000,
      step: 500,
      rerenderEvery: 1_000,
    });

    // Then again until 6 answers in a row were missing products.
    expect(at).toEqual(
      [0, 1, 2, 3, 4, 5].map(polls => polls * PLAN_MISSING_POLL_MS)
    );
  });

  it("asks for the made list every 5 s while a kit is made, from the page's first load", async () => {
    // Nothing cached yet: the first answer is what says to keep asking.
    jest
      .mocked(fetchProductsMade)
      .mockResolvedValue(made([kit("making")], "making"));
    const { rerender } = renderHook(() => useProductsMade("workspace-1"), {
      wrapper: swr,
    });
    await act(async () => {});

    const at = await askedAt(jest.mocked(fetchProductsMade), rerender, {
      until: 16_000,
      step: 1_000,
      rerenderEvery: 3_000,
    });

    expect(at).toEqual([0, 1, 2, 3].map(polls => polls * MADE_MAKING_POLL_MS));
  });
});

test("elapsed time reads as a clock", () => {
  expect(formatElapsed(38_400)).toBe("0:38");
  expect(formatElapsed(64_000)).toBe("1:04");
  expect(formatElapsed(-5)).toBe("0:00");
});

test("when something was made: today, yesterday, or its day", () => {
  const words = {
    today: (time: string) => `today at ${time}`,
    yesterday: (time: string) => `yesterday at ${time}`,
    onDay: (day: string, time: string) => `${day} at ${time}`,
  };
  const now = new Date(2026, 10, 3, 12, 0);

  expect(madeWhen(new Date(2026, 10, 3, 9, 14).toISOString(), now, words)).toBe(
    "today at 09:14"
  );
  expect(madeWhen(new Date(2026, 10, 2, 23, 5).toISOString(), now, words)).toBe(
    "yesterday at 23:05"
  );
  expect(madeWhen(new Date(2026, 9, 30, 8, 0).toISOString(), now, words)).toBe(
    "30 Oct at 08:00"
  );
});
