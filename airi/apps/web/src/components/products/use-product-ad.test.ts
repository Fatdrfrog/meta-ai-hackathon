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

// Studio v3: free changes wait for Update, merged, one PATCH at a time.

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

  it("never sends a pick by itself: the picks wait for Update", async () => {
    const { result } = renderHook(() =>
      useAdAutoUpdate({ workspaceId: "w", ad: studioAd(), onAd: jest.fn() })
    );
    act(() => result.current.queue({ sticker: "Opening two" }));
    act(() =>
      result.current.queue({ scenes: [{ productId: DOLL, useExact: true }] })
    );
    await advance(60_000);

    expect(update()).not.toHaveBeenCalled();
    expect(result.current.sending).toBe(false);
    expect(result.current.pending).toEqual({
      sticker: "Opening two",
      scenes: [{ productId: DOLL, useExact: true }],
    });
  });

  it("sends every pick as one PATCH when Update is pressed", async () => {
    update().mockResolvedValue(studioAd({ status: "making", renderNo: 2 }));
    const onAd = jest.fn();
    const { result } = renderHook(() =>
      useAdAutoUpdate({ workspaceId: "w", ad: studioAd(), onAd })
    );
    act(() => result.current.queue({ sticker: "Opening two" }));
    act(() =>
      result.current.queue({ scenes: [{ productId: DOLL, useExact: true }] })
    );
    act(() => result.current.queue({ sticker: "Opening three" }));
    act(() => result.current.send());
    expect(result.current.sending).toBe(true);
    await advance(0);

    expect(update()).toHaveBeenCalledTimes(1);
    expect(update()).toHaveBeenCalledWith("w", "ad-1", {
      sticker: "Opening three",
      scenes: [{ productId: DOLL, useExact: true }],
    });
    expect(onAd).toHaveBeenCalledWith(
      expect.objectContaining({ status: "making", renderNo: 2 })
    );
    expect(result.current.pending).toBeNull();
    expect(result.current.sending).toBe(false);
  });

  it("sends a press made while a run goes once the run ends", async () => {
    update().mockResolvedValue(studioAd({ status: "making", renderNo: 3 }));
    let ad = studioAd({ status: "making", renderNo: 2 });
    const { result, rerender } = renderHook(() =>
      useAdAutoUpdate({ workspaceId: "w", ad, onAd: jest.fn() })
    );
    act(() => result.current.queue({ motion: "filmed_sold" }));
    act(() => result.current.queue({ ending: "Ending two" }));
    act(() => result.current.send());
    await advance(10_000);
    expect(update()).not.toHaveBeenCalled();
    expect(result.current.sending).toBe(true);

    ad = studioAd({ status: "ready", renderNo: 2 });
    rerender();
    await advance(0);
    expect(update()).toHaveBeenCalledTimes(1);
    expect(update()).toHaveBeenCalledWith("w", "ad-1", {
      motion: "filmed_sold",
      ending: "Ending two",
    });
  });

  it("keeps the press on 409 ad_not_ready and asks for the ad again", async () => {
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
    act(() => result.current.send());
    await advance(0);
    expect(update()).toHaveBeenCalledTimes(1);
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toEqual({ motion: "filmed_sold" });
    expect(result.current.problem).toBeNull();

    await advance(PRODUCT_AD_BUSY_RETRY_MS);
    expect(update()).toHaveBeenCalledTimes(2);
    expect(result.current.pending).toBeNull();
  });

  it("says why another refusal stopped it, and keeps the picks to try again", async () => {
    update().mockRejectedValue(new ProductDraftError("invalid_request"));
    const { result } = renderHook(() =>
      useAdAutoUpdate({ workspaceId: "w", ad: studioAd(), onAd: jest.fn() })
    );
    act(() => result.current.queue({ sticker: "Opening two" }));
    act(() => result.current.send());
    await advance(0);
    expect(result.current.problem).toBe("invalid_request");
    expect(result.current.pending).toEqual({ sticker: "Opening two" });
    expect(result.current.sending).toBe(false);

    // Nothing goes again until the next press.
    await advance(60_000);
    expect(update()).toHaveBeenCalledTimes(1);
  });

  it("holds a pick made after Update was pressed for the next press", async () => {
    update().mockResolvedValue(studioAd({ status: "making", renderNo: 3 }));
    let ad = studioAd({ status: "making", renderNo: 2 });
    const { result, rerender } = renderHook(() =>
      useAdAutoUpdate({ workspaceId: "w", ad, onAd: jest.fn() })
    );
    act(() => result.current.queue({ motion: "filmed_sold" }));
    act(() => result.current.send());
    act(() => result.current.queue({ ending: "Ending two" }));
    ad = studioAd({ status: "ready", renderNo: 2 });
    rerender();
    await advance(10_000);
    expect(update()).not.toHaveBeenCalled();

    act(() => result.current.send());
    await advance(0);
    expect(update()).toHaveBeenCalledWith("w", "ad-1", {
      motion: "filmed_sold",
      ending: "Ending two",
    });
  });

  it("hands what waits to a paid run, and Discard drops it", async () => {
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
    act(() => result.current.send());
    await advance(10_000);
    expect(update()).not.toHaveBeenCalled();
    expect(result.current.pending).toBeNull();
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

  it("sends a pressed Update after the workbench closes", async () => {
    const view = await setup();
    act(() => latest.queue({ sticker: "Keep this edit" }));
    act(() => latest.send());
    view.rerender(view.tree(false));
    await advance(0);
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

  it("keeps picks across tile remounts, and Update sends only its own ad's", async () => {
    const view = await setup();
    act(() => latest.queue({ sticker: "First ad" }));
    view.rerender(view.tree(true, "ad-1", "tile-2"));
    await act(async () => {});
    expect(latest.pending).toEqual({ sticker: "First ad" });
    view.rerender(view.tree(true, "ad-2", "tile-3"));
    await act(async () => {});
    act(() => latest.queue({ ending: "Second ad" }));
    act(() => latest.send());
    await advance(0);
    expect(updateProductAd).toHaveBeenCalledTimes(1);
    expect(updateProductAd).toHaveBeenCalledWith("w", "ad-2", {
      ending: "Second ad",
    });

    view.rerender(view.tree(true, "ad-1", "tile-4"));
    await act(async () => {});
    expect(latest.pending).toEqual({ sticker: "First ad" });
  });

  it("sends an Update pressed in the same event that closes the workbench", async () => {
    const view = await setup();
    act(() => {
      latest.queue({ sticker: "Same event edit" });
      latest.send();
      view.rerender(view.tree(false));
    });
    await act(async () => {
      jest.runAllTicks();
    });
    await advance(0);
    expect(updateProductAd).toHaveBeenCalledTimes(1);
    expect(updateProductAd).toHaveBeenCalledWith("w", "ad-1", {
      sticker: "Same event edit",
    });
  });

  it("holds a pick made during an in-flight update for the next press", async () => {
    await setup();
    let finish!: (ad: ProductAdRecord) => void;
    jest.mocked(updateProductAd).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    act(() => latest.queue({ sticker: "First" }));
    act(() => latest.send());
    await advance(0);
    act(() => latest.queue({ ending: "Next" }));
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
    await advance(10_000);
    expect(updateProductAd).toHaveBeenCalledTimes(1);
    expect(latest.pending).toEqual({ ending: "Next" });

    act(() => latest.send());
    await advance(0);
    expect(updateProductAd).toHaveBeenLastCalledWith("w", "ad-1", {
      ending: "Next",
    });
    expect(updateProductAd).toHaveBeenCalledTimes(2);
  });
});
