/** @jest-environment jsdom */

import {
  createProductAd,
  downloadProductAdFile,
  fetchProductAd,
  fetchProductAdBrief,
  productAdBriefUrl,
  productAdRetryUrl,
  productAdSceneUrl,
  redoProductAdScene,
  retryProductAd,
  updateProductAd,
} from "./ads-client";
import { ProductDraftError, productAdUrl } from "./products-client";
import { PRODUCT_AD_POLL_MS, productAdPollInterval } from "./use-product-ad";

// The studio's requests: what they ask, and how a failure reaches the studio.

const WS = "workspace 1";
const DOLL = "651f1f77bcf86cd799439011";
const MUG = "651f1f77bcf86cd799439012";
const AD = "751f1f77bcf86cd799439031";
const ad = { id: AD, status: "making", products: [] };

const respond = (body: unknown, status = 200) =>
  jest.fn(async () => ({
    ok: status < 400,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;

describe("the studio's addresses", () => {
  it("asks for a brief by its products, and retries an ad", () => {
    expect(productAdBriefUrl(WS, [DOLL, MUG])).toBe(
      `/api/workspaces/workspace%201/products/ads/brief?products=${DOLL},${MUG}`
    );
    expect(productAdRetryUrl(WS, AD)).toBe(
      `/api/workspaces/workspace%201/products/ads/${AD}/retry`
    );
  });
});

describe("the studio's requests", () => {
  it("makes an ad from the brief", async () => {
    global.fetch = respond({ ad }, 201);
    const request = {
      requestId: "press-1",
      productIds: [DOLL],
      idea: { kind: "new" as const },
      voice: "own" as const,
      presenter: { use: false, consent: false },
    };

    expect(await createProductAd(WS, request)).toEqual(ad);
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/workspaces/workspace%201/products/ads",
      {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      }
    );
  });

  it("sends the owner's edits, and asks to try again", async () => {
    global.fetch = respond({ ad }, 202);
    await updateProductAd(WS, AD, { sticker: "Жаңа" });
    expect(global.fetch).toHaveBeenLastCalledWith(productAdUrl(WS, AD), {
      method: "PATCH",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sticker: "Жаңа" }),
    });

    await retryProductAd(WS, AD);
    expect(global.fetch).toHaveBeenLastCalledWith(productAdRetryUrl(WS, AD), {
      method: "POST",
      cache: "no-store",
    });
  });

  it("asks for a New picture on one scene, with the waiting changes", async () => {
    global.fetch = respond({ ad }, 202);
    const request = {
      requestId: "press-2",
      setting: "gift_table" as const,
      changes: { scenes: [{ productId: MUG, textZone: "top" as const }] },
    };
    expect(await redoProductAdScene(WS, AD, DOLL, request)).toEqual(ad);
    expect(productAdSceneUrl(WS, AD, DOLL)).toBe(
      `/api/workspaces/workspace%201/products/ads/${AD}/scenes/${DOLL}`
    );
    expect(global.fetch).toHaveBeenLastCalledWith(
      productAdSceneUrl(WS, AD, DOLL),
      {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      }
    );

    global.fetch = respond({ error: "x", code: "no_pictures_left" }, 409);
    await expect(
      redoProductAdScene(WS, AD, DOLL, { requestId: "p", words: "a yurt" })
    ).rejects.toEqual(new ProductDraftError("no_pictures_left"));
  });

  it("reads one ad and a brief", async () => {
    global.fetch = respond({ ad });
    expect(await fetchProductAd(productAdUrl(WS, AD))).toEqual(ad);

    const brief = { products: [], missing: 0 };
    global.fetch = respond({ brief });
    expect(await fetchProductAdBrief(productAdBriefUrl(WS, [DOLL]))).toEqual(
      brief
    );
  });

  it("throws the API's code, and 'failed' for an answer that isn't an ad", async () => {
    global.fetch = respond({ error: "x", code: "ad_letters_unsupported" }, 409);
    await expect(
      createProductAd(WS, {
        requestId: "press-1",
        productIds: [DOLL],
        idea: { kind: "new" },
        voice: "none",
        presenter: { use: false, consent: false },
      })
    ).rejects.toEqual(new ProductDraftError("ad_letters_unsupported"));

    global.fetch = respond({ ad: { id: AD } });
    await expect(fetchProductAd(productAdUrl(WS, AD))).rejects.toEqual(
      new ProductDraftError("failed")
    );

    global.fetch = respond({ brief: null });
    await expect(
      fetchProductAdBrief(productAdBriefUrl(WS, [DOLL]))
    ).rejects.toEqual(new ProductDraftError("failed"));
  });
});

describe("saving one of the ad's files", () => {
  it("fetches it and saves it under its name", async () => {
    const click = jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const createObjectURL = jest.fn(() => "blob:poster");
    const revokeObjectURL = jest.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    global.fetch = jest.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["jpg"], { type: "image/jpeg" }),
    })) as unknown as typeof fetch;
    jest.useFakeTimers();

    await downloadProductAdFile("https://signed.test/status.jpg", "status.jpg");

    expect(global.fetch).toHaveBeenCalledWith("https://signed.test/status.jpg");
    const link = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(link.download).toBe("status.jpg");
    expect(link.href).toBe("blob:poster");
    expect(link.isConnected).toBe(false);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    jest.advanceTimersByTime(60_000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:poster");
    jest.useRealTimers();
    click.mockRestore();
  });

  it("opens it in a new tab when it can't be fetched", async () => {
    const openTab = jest.spyOn(window, "open").mockReturnValue(null);
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 403,
    })) as unknown as typeof fetch;

    await downloadProductAdFile("https://signed.test/ad.mp4", "ad.mp4");

    expect(openTab).toHaveBeenCalledWith(
      "https://signed.test/ad.mp4",
      "_blank",
      "noopener,noreferrer"
    );
    openTab.mockRestore();
  });
});

describe("asking while the ad is made", () => {
  it("asks every 2 s while it's made, and stops once it's ready or failed", () => {
    expect(PRODUCT_AD_POLL_MS).toBe(2000);
    expect(
      productAdPollInterval({ status: "making" } as Parameters<
        typeof productAdPollInterval
      >[0])
    ).toBe(2000);
    for (const status of ["ready", "failed"] as const)
      expect(
        productAdPollInterval({ status } as Parameters<
          typeof productAdPollInterval
        >[0])
      ).toBe(0);
    expect(productAdPollInterval(undefined)).toBe(0);
  });
});
