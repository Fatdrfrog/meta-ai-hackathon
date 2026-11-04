/** @jest-environment jsdom */

import {
  createCtwaAd,
  fetchMetaReadiness,
  loadAdPost,
  loadCtwaAd,
  loadMetaReadiness,
  productAdCtwaUrl,
  productAdPostUrl,
  productAdPublishUrl,
  productsMetaUrl,
  publishAdPost,
  refreshMetaReadiness,
  runCtwaAd,
} from "./meta-client";
import { ProductDraftError } from "./products-client";

// Studio v3's Meta actions: what they ask, and how a failure reaches the
// workbench.

const WS = "workspace 1";
const AD = "751f1f77bcf86cd799439031";
const BASE = `/api/workspaces/workspace%201/products`;

const post = {
  id: "post-1",
  destination: "reel",
  still: null,
  slides: [],
  renderNo: 2,
  motion: "shelf",
  state: "processing",
  permalink: null,
  errorCode: null,
  errorMessage: null,
  requestedAt: "2026-11-04T01:00:00.000Z",
  publishedAt: null,
};

const ctwa = {
  attempt: 1,
  asset: "video",
  state: "campaign",
  effectiveStatus: null,
  adsManagerUrl: null,
  dailyBudgetCents: null,
  endsAt: null,
  errorCode: null,
  errorMessage: null,
};

const respond = (body: unknown, status = 200) =>
  jest.fn(async () => ({
    ok: status < 400,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;

describe("the Meta actions' addresses", () => {
  it("posts an ad, reads one post, and makes its WhatsApp ad", () => {
    expect(productsMetaUrl(WS)).toBe(`${BASE}/meta`);
    expect(productsMetaUrl(WS, { fresh: true })).toBe(`${BASE}/meta?fresh=1`);
    expect(productAdPublishUrl(WS, AD)).toBe(`${BASE}/ads/${AD}/publish`);
    expect(productAdPostUrl(WS, AD, "post 1")).toBe(
      `${BASE}/ads/${AD}/publish/post%201`
    );
    expect(productAdCtwaUrl(WS, AD)).toBe(`${BASE}/ads/${AD}/ctwa`);
  });
});

describe("posting on Instagram", () => {
  it("sends the press and answers the post", async () => {
    global.fetch = respond({ post }, 202);
    const request = {
      requestId: "press-1",
      destination: "reel" as const,
      caption: "Жаңа тауарлар",
    };

    expect(await publishAdPost(WS, AD, request)).toEqual(post);
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/ads/${AD}/publish`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  });

  it("reads a post, and throws the API's code when Instagram isn't connected", async () => {
    global.fetch = respond({ post: { ...post, state: "published" } });
    expect(await loadAdPost(WS, AD, "post-1")).toMatchObject({
      state: "published",
    });

    global.fetch = respond(
      { error: "No Instagram", code: "instagram_not_connected" },
      409
    );
    await expect(
      publishAdPost(WS, AD, { requestId: "press-2", destination: "story" })
    ).rejects.toMatchObject({ code: "instagram_not_connected" });
  });

  it("refuses an answer without a post", async () => {
    global.fetch = respond({ post: null }, 202);
    await expect(
      publishAdPost(WS, AD, { requestId: "press-3", destination: "post" })
    ).rejects.toBeInstanceOf(ProductDraftError);
  });
});

describe("the Click-to-WhatsApp ad", () => {
  it("creates it, reads it (none before it's asked for), and runs it", async () => {
    global.fetch = respond({ ctwa }, 202);
    expect(
      await createCtwaAd(WS, AD, { requestId: "press-4", asset: "video" })
    ).toEqual(ctwa);

    global.fetch = respond({ ctwa: null });
    expect(await loadCtwaAd(WS, AD)).toBeNull();

    global.fetch = respond({ ctwa: { ...ctwa, state: "running" } });
    expect(
      await runCtwaAd(WS, AD, { dailyBudgetCents: 100, days: 3 })
    ).toMatchObject({ state: "running" });
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/ads/${AD}/ctwa/run`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dailyBudgetCents: 100, days: 3 }),
    });
  });

  it("throws the API's code for a budget above the caps", async () => {
    global.fetch = respond({ error: "Too much", code: "budget_refused" }, 409);
    await expect(
      runCtwaAd(WS, AD, { dailyBudgetCents: 500, days: 7 })
    ).rejects.toMatchObject({ code: "budget_refused" });
  });
});

describe("what the workspace can do on Meta", () => {
  it("reads it, and refuses an answer without it", async () => {
    const meta = {
      instagram: {
        connected: true,
        username: "airi.chat__",
        canPublish: true,
        quotaLeft: 100,
      },
      ads: { connected: false },
      whatsapp: { connected: true },
      ai: { blocked: null },
    };
    global.fetch = respond({ meta });
    expect(await loadMetaReadiness(WS)).toEqual(meta);
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/meta`, {
      method: "GET",
      cache: "no-store",
    });

    global.fetch = respond({});
    await expect(fetchMetaReadiness(`${BASE}/meta`)).rejects.toBeInstanceOf(
      ProductDraftError
    );
  });

  it("reads it again past the server's cache for Check again", async () => {
    const meta = {
      instagram: { connected: false },
      ads: { connected: true, pageHasWhatsApp: true },
      whatsapp: { connected: true },
      ai: { blocked: null },
    };
    global.fetch = respond({ meta });
    expect(await refreshMetaReadiness(WS)).toEqual(meta);
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/meta?fresh=1`, {
      method: "GET",
      cache: "no-store",
    });
  });
});
