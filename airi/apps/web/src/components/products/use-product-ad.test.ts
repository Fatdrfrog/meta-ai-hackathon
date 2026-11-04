/** @jest-environment jsdom */
import type { ProductAdRecord } from "@/lib/products/types";
import { act, render, renderHook } from "@testing-library/react";
import { createElement, useEffect, type ReactNode } from "react";
import { SWRConfig } from "swr";
import { fetchProductAd, updateProductAd } from "./ads-client";
import { ProductDraftError } from "./products-client";
import {
  effectiveAdChanges,
  mergeAdChanges,
  PRODUCT_AD_AUTO_UPDATE_MS,
  PRODUCT_AD_BUSY_RETRY_MS,
  PRODUCT_AD_POLL_MS,
  useAdAutoUpdate,
  useProductAd,
  useSharedAdAutoUpdate,
  ProductAdAutoUpdateProvider,
  type ProductAdAutoUpdate,
} from "./use-product-ad";

jest.mock("./ads-client", () => ({
  ...jest.requireActual("./ads-client"),
  fetchProductAd: jest.fn(),
  updateProductAd: jest.fn(),
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

// Studio v3: free changes apply themselves, merged, one PATCH at a time.

const DOLL = "doll";
const MUG = "mug";

const studioAd = (overrides: Partial<ProductAdRecord> = {}) =>
  ({
    id: "ad-1",
    status: "ready",
    motion: "shelf",
    renderNo: 1,
    script: {
      sticker: "Opening one",
      captions: [{ productId: DOLL, caption: "Doll words" }],
      priceCardTitle: "Title",
      ending: "Ending one",
    },
    scenes: [
      {
        productId: DOLL,
        method: "muse",
        textZone: "auto",
        useExact: false,
        pictures: [
          { index: 0, url: null, place: "Oak", current: false },
          { index: 1, url: null, place: "Linen", current: true },
        ],
      },
      {
        productId: MUG,
        method: "exact",
        textZone: "auto",
        useExact: true,
        pictures: [],
      },
    ],
    ...overrides,
  }) as unknown as ProductAdRecord;

describe("free changes", () => {
  it("merge field by field, scene by scene, the later one winning", () => {
    expect(
      mergeAdChanges(
        { sticker: "A", scenes: [{ productId: DOLL, pictureIndex: 0 }] },
        {
          motion: "float",
          scenes: [
            { productId: DOLL, useExact: true },
            { productId: MUG, textZone: "top" },
          ],
        }
      )
    ).toEqual({
      sticker: "A",
      motion: "float",
      scenes: [
        { productId: DOLL, useExact: true },
        { productId: MUG, textZone: "top" },
      ],
    });
    // A kept picture picked after Wall turns the exact photo off.
    expect(
      mergeAdChanges(
        { scenes: [{ productId: DOLL, useExact: true }] },
        { scenes: [{ productId: DOLL, pictureIndex: 0 }] }
      ).scenes
    ).toEqual([{ productId: DOLL, useExact: false, pictureIndex: 0 }]);
  });

  it("leave out what the video already shows", () => {
    const ad = studioAd();
    expect(
      effectiveAdChanges(ad, {
        motion: "shelf",
        sticker: "Opening one",
        scenes: [{ productId: DOLL, pictureIndex: 1, useExact: false }],
      })
    ).toBeNull();
    expect(
      effectiveAdChanges(ad, {
        motion: "filmed_sold",
        ending: "Ending two",
        scenes: [
          { productId: DOLL, pictureIndex: 0, useExact: false },
          { productId: MUG, useExact: true },
        ],
      })
    ).toEqual({
      motion: "filmed_sold",
      ending: "Ending two",
      scenes: [{ productId: DOLL, pictureIndex: 0 }],
    });
  });
});

describe("useAdAutoUpdate", () => {
  const update = () => jest.mocked(updateProductAd);
  beforeEach(() => update().mockReset());

  const advance = async (ms: number) => {
    await act(async () => {
      jest.advanceTimersByTime(ms);
    });
  };

  it("sends one PATCH for a burst of changes, 1.5 s after the last", async () => {
    update().mockResolvedValue(studioAd({ status: "making", renderNo: 2 }));
    const onAd = jest.fn();
    const { result } = renderHook(() =>
      useAdAutoUpdate({ workspaceId: "w", ad: studioAd(), onAd })
    );
    act(() => result.current.queue({ sticker: "Opening two" }));
    await advance(1000);
    act(() =>
      result.current.queue({ scenes: [{ productId: DOLL, useExact: true }] })
    );
    await advance(1000);
    act(() => result.current.queue({ sticker: "Opening three" }));
    expect(result.current.pending).toEqual({
      sticker: "Opening three",
      scenes: [{ productId: DOLL, useExact: true }],
    });
    await advance(PRODUCT_AD_AUTO_UPDATE_MS - 1);
    expect(update()).not.toHaveBeenCalled();
    await advance(1);

    expect(update()).toHaveBeenCalledTimes(1);
    expect(update()).toHaveBeenCalledWith("w", "ad-1", {
      sticker: "Opening three",
      scenes: [{ productId: DOLL, useExact: true }],
    });
    expect(onAd).toHaveBeenCalledWith(
      expect.objectContaining({ status: "making", renderNo: 2 })
    );
    expect(result.current.pending).toBeNull();
  });

  it("waits while a run goes, then sends what waits as one change", async () => {
    update().mockResolvedValue(studioAd({ status: "making", renderNo: 3 }));
    let ad = studioAd({ status: "making", renderNo: 2 });
    const { result, rerender } = renderHook(() =>
      useAdAutoUpdate({ workspaceId: "w", ad, onAd: jest.fn() })
    );
    act(() => result.current.queue({ motion: "filmed_sold" }));
    act(() => result.current.queue({ ending: "Ending two" }));
    await advance(10_000);
    expect(update()).not.toHaveBeenCalled();

    ad = studioAd({ status: "ready", renderNo: 2 });
    rerender();
    await advance(0);
    expect(update()).toHaveBeenCalledTimes(1);
    expect(update()).toHaveBeenCalledWith("w", "ad-1", {
      motion: "filmed_sold",
      ending: "Ending two",
    });
  });

  it("keeps the change on 409 ad_not_ready and asks for the ad again", async () => {
    update()
      .mockRejectedValueOnce(new ProductDraftError("ad_not_ready"))
      .mockResolvedValue(studioAd({ status: "making", renderNo: 2 }));
    const onStale = jest.fn();
    const { result } = renderHook(() =>
      useAdAutoUpdate({
        workspaceId: "w",
        ad: studioAd(),
        onAd: jest.fn(),
        onStale,
      })
    );
    act(() => result.current.queue({ motion: "filmed_sold" }));
    await advance(PRODUCT_AD_AUTO_UPDATE_MS);
    expect(update()).toHaveBeenCalledTimes(1);
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toEqual({ motion: "filmed_sold" });
    expect(result.current.problem).toBeNull();

    await advance(PRODUCT_AD_BUSY_RETRY_MS);
    expect(update()).toHaveBeenCalledTimes(2);
    expect(result.current.pending).toBeNull();
  });

  it("says why another refusal dropped the change", async () => {
    update().mockRejectedValue(new ProductDraftError("invalid_request"));
    const { result } = renderHook(() =>
      useAdAutoUpdate({ workspaceId: "w", ad: studioAd(), onAd: jest.fn() })
    );
    act(() => result.current.queue({ sticker: "Opening two" }));
    await advance(PRODUCT_AD_AUTO_UPDATE_MS);
    expect(result.current.problem).toBe("invalid_request");
    expect(result.current.pending).toBeNull();
  });

  it("hands what waits to a paid run, and Back to the video drops it", async () => {
    const { result } = renderHook(() =>
      useAdAutoUpdate({ workspaceId: "w", ad: studioAd(), onAd: jest.fn() })
    );
    act(() => result.current.queue({ sticker: "Opening two" }));
    let taken: unknown;
    act(() => {
      taken = result.current.take();
    });
    expect(taken).toEqual({ sticker: "Opening two" });
    expect(result.current.pending).toBeNull();

    act(() => result.current.queue({ sticker: "Opening three" }));
    act(() => result.current.cancel());
    await advance(PRODUCT_AD_AUTO_UPDATE_MS * 2);
    expect(update()).not.toHaveBeenCalled();
  });
});

describe("page-owned free changes", () => {
  let latest: ProductAdAutoUpdate;
  const Consumer = ({ adId }: { adId: string }) => {
    const { data: current } = useProductAd("w", adId);
    const shared = useSharedAdAutoUpdate({
      workspaceId: "w",
      ad: current,
      onAd: jest.fn(),
    });
    useEffect(() => {
      latest = shared;
    });
    return null;
  };
  const setup = async () => {
    jest
      .mocked(updateProductAd)
      .mockReset()
      .mockImplementation(async (_workspace, id) =>
        studioAd({ id, status: "making", renderNo: 2 })
      );
    jest
      .mocked(fetchProductAd)
      .mockImplementation(async url =>
        studioAd({ id: String(url).split("/").pop()! })
      );
    const cache = new Map();
    const tree = (visible: boolean, adId = "ad-1", key = "tile-1") =>
      createElement(
        SWRConfig,
        { value: { provider: () => cache, dedupingInterval: 0 } },
        createElement(
          ProductAdAutoUpdateProvider,
          { workspaceId: "w" },
          visible ? createElement(Consumer, { key, adId }) : null
        )
      );
    const view = render(tree(true));
    await act(async () => {});
    return { ...view, tree };
  };
  const advance = async (ms: number) => {
    await act(async () => {
      jest.advanceTimersByTime(ms);
    });
  };

  it("sends the queued edit after the workbench closes before debounce", async () => {
    const view = await setup();
    act(() => latest.queue({ sticker: "Keep this edit" }));
    view.rerender(view.tree(false));
    await advance(PRODUCT_AD_AUTO_UPDATE_MS);
    expect(updateProductAd).toHaveBeenCalledTimes(1);
    expect(updateProductAd).toHaveBeenCalledWith("w", "ad-1", {
      sticker: "Keep this edit",
    });
    await act(async () => {
      jest.runAllTicks();
    });
    // A settled, closed controller is removed instead of polling forever.
    const reads = jest.mocked(fetchProductAd).mock.calls.length;
    await advance(20_000);
    expect(fetchProductAd).toHaveBeenCalledTimes(reads);
  });

  it("preserves pending edits across tile remounts and keeps different ads separate", async () => {
    const view = await setup();
    act(() => latest.queue({ sticker: "First ad" }));
    view.rerender(view.tree(true, "ad-1", "tile-2"));
    await act(async () => {});
    expect(latest.pending).toEqual({ sticker: "First ad" });
    view.rerender(view.tree(true, "ad-2", "tile-3"));
    await act(async () => {});
    act(() => latest.queue({ ending: "Second ad" }));
    await advance(PRODUCT_AD_AUTO_UPDATE_MS);
    expect(updateProductAd).toHaveBeenCalledWith("w", "ad-1", {
      sticker: "First ad",
    });
    expect(updateProductAd).toHaveBeenCalledWith("w", "ad-2", {
      ending: "Second ad",
    });
    expect(updateProductAd).toHaveBeenCalledTimes(2);
  });

  it("keeps an edit queued in the same event that closes the workbench", async () => {
    const view = await setup();
    act(() => {
      latest.queue({ sticker: "Same event edit" });
      view.rerender(view.tree(false));
    });
    await act(async () => {
      jest.runAllTicks();
    });
    await advance(PRODUCT_AD_AUTO_UPDATE_MS);
    expect(updateProductAd).toHaveBeenCalledTimes(1);
    expect(updateProductAd).toHaveBeenCalledWith("w", "ad-1", {
      sticker: "Same event edit",
    });
  });

  it("keeps edits made during an in-flight request after closing", async () => {
    const view = await setup();
    let finish!: (ad: ProductAdRecord) => void;
    jest.mocked(updateProductAd).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    act(() => latest.queue({ sticker: "First" }));
    await advance(PRODUCT_AD_AUTO_UPDATE_MS);
    act(() => latest.queue({ ending: "Next" }));
    view.rerender(view.tree(false));
    await act(async () => {
      finish(
        studioAd({
          status: "making",
          renderNo: 2,
          script: { ...studioAd().script!, sticker: "First" },
        })
      );
    });
    jest.mocked(fetchProductAd).mockResolvedValue(
      studioAd({
        renderNo: 2,
        script: { ...studioAd().script!, sticker: "First" },
      })
    );
    await advance(PRODUCT_AD_POLL_MS);
    await advance(PRODUCT_AD_AUTO_UPDATE_MS);
    expect(updateProductAd).toHaveBeenLastCalledWith("w", "ad-1", {
      ending: "Next",
    });
    expect(updateProductAd).toHaveBeenCalledTimes(2);
  });
});
