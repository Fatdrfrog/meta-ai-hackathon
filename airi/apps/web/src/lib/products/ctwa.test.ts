/** @jest-environment node */

// The Click-to-WhatsApp ad's server half: readiness, "Create ad" made PAUSED
// step by step (video → campaign → ad set → creative → ad), resuming after
// any step, finding a lost answer by its name, the lease, the review state,
// and Run behind its env switch and caps. Meta is a fake ad account that
// remembers what it made by name; the ad is an in-memory document.

jest.mock("@/models/product-ad", () => ({ ProductAd: {} }));
jest.mock("@/models/workspace-product", () => ({ WorkspaceProduct: {} }));
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
jest.mock("@/lib/products/photo-urls", () => ({
  productPhotoUrl: jest.fn(),
}));
jest.mock("@/lib/google/creative-asset-read-url-media-api-adapter", () => ({
  ensureMediaApiCreativeAssetReadUrlPort: jest.fn(),
}));

import { MetaAdsGraphError } from "@/lib/meta-ads/ctwa";
import type { ProductAdStoredCtwa } from "@/models/product-ad";
import {
  createCtwa,
  ctwaObjectName,
  ctwaReadiness,
  loadCtwa,
  parseCtwaRequest,
  parseCtwaRunRequest,
  productsCtwaRunCaps,
  runCtwa,
  toCtwaRecord,
  type CtwaAdDoc,
  type CtwaDeps,
  type CtwaGraph,
  type CtwaRefusal,
  type CtwaStore,
} from "./ctwa";

const WS = "workspace-1";
const AD = "751f1f77bcf86cd799439031";
const ref = (path: string) => ({ bucket: "media", path });

// ---------------------------------------------------------------------------
// The ad, in memory

let doc: CtwaAdDoc | null;
let clock: Date;

function readyAd(overrides: Partial<CtwaAdDoc> = {}): CtwaAdDoc {
  return {
    _id: AD,
    status: "ready",
    products: [
      { productId: "p1", name: "Кесе" },
      { productId: "p2", name: "Шәйнек" },
    ] as CtwaAdDoc["products"],
    render: {
      renderNo: 2,
      video: ref("ads/ad.mp4"),
      poster: ref("ads/poster.jpg"),
      bytes: 1,
      seconds: 12,
      width: 1080,
      height: 1920,
      ms: 1,
    },
    script: {
      ctwa: {
        headline: "Кеселер",
        primaryText: "Жаңа кеселер келді",
        greeting: "Сәлем!",
        questions: ["Жеткізу бар ма?", "Қай жерде орналасқансыз?"],
      },
    } as unknown as CtwaAdDoc["script"],
    stills: { status: null, feed: ref("ads/feed-v2.jpg") },
    stillSet: {
      renderNo: 2,
      items: [
        {
          kind: "studio",
          format: "feed",
          productId: "p1",
          colourway: "sand",
          ref: ref("ads/studio-p1.jpg"),
        },
        {
          kind: "room",
          format: "feed",
          productId: "p1",
          colourway: null,
          ref: ref("ads/room-p1.jpg"),
        },
      ],
    },
    meta: undefined,
    ...overrides,
  };
}

const ctwaOf = () => doc?.meta?.ctwa ?? null;

/** A deep copy, as a query returns one; dates stay this realm's dates. */
function copy<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map(copy) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, copy(entry)])
    ) as T;
  return value;
}

const store: CtwaStore = {
  async load() {
    return doc ? copy(doc) : null;
  },
  async replace(_ws, _ad, expected, next) {
    if (!doc) return false;
    const current = doc.meta?.ctwa ?? null;
    if ((current?.requestId ?? null) !== expected) return false;
    doc.meta = { ...(doc.meta ?? {}), ctwa: copy(next) };
    return true;
  },
  async lease(_ws, _ad, requestId, now, until) {
    const ctwa = ctwaOf();
    if (!doc || ctwa?.requestId !== requestId) return null;
    if (ctwa.leaseUntil && ctwa.leaseUntil.getTime() > now.getTime())
      return null;
    ctwa.leaseUntil = until;
    return copy(doc);
  },
  async save(_ws, _ad, held, patch) {
    const ctwa = ctwaOf();
    if (
      !ctwa ||
      ctwa.requestId !== held.requestId ||
      ctwa.leaseUntil?.getTime() !== held.leaseUntil.getTime()
    )
      return false;
    Object.assign(ctwa, copy(patch));
    return true;
  },
};

// ---------------------------------------------------------------------------
// Meta: a fake ad account that remembers what it made, by name.

type Made = { id: string; name: string; status: string };
let made: Record<
  "campaigns" | "adsets" | "adcreatives" | "ads" | "videos",
  Made[]
>;
let videoState: "processing" | "ready" | "error";
let review: { effectiveStatus: string | null; feedback: string | null };
let pageLinked: boolean | null;
let currency: string | null;
let counter = 0;

const created = (edge: keyof typeof made, name: string) => {
  const object = { id: `${edge}-${++counter}`, name, status: "PAUSED" };
  made[edge].push(object);
  return object.id;
};

function fakeGraph(): jest.Mocked<CtwaGraph> {
  return {
    adAccountInfo: jest.fn(async () => ({ name: "Airi.chat", currency })),
    promotablePages: jest.fn(async () => [{ id: "page-1", name: "Airi.chat" }]),
    pageWhatsAppLinked: jest.fn(async () => pageLinked),
    findByName: jest.fn(
      async (_auth: unknown, edge: keyof typeof made, name: string) =>
        made[edge].find(object => object.name === name)?.id ?? null
    ),
    findAdVideoByName: jest.fn(
      async (_auth, name) =>
        made.videos.find(object => object.name === name)?.id ?? null
    ),
    uploadAdVideo: jest.fn(async (_auth, params) =>
      created("videos", params.name)
    ),
    adVideoStatus: jest.fn(async () => ({
      state: videoState,
      reason: videoState === "error" ? "Bad codec" : null,
    })),
    uploadAdImage: jest.fn(async () => "image-hash-1"),
    createCampaign: jest.fn(async (_auth, params) =>
      created("campaigns", params.name)
    ),
    validateAdSet: jest.fn(async () => undefined),
    createAdSet: jest.fn(async (_auth, params) =>
      created("adsets", params.name)
    ),
    createAdCreative: jest.fn(async (_auth, params) =>
      created("adcreatives", params.name)
    ),
    createAd: jest.fn(async (_auth, params) => created("ads", params.name)),
    setAdSetBudget: jest.fn(async () => undefined),
    setObjectStatus: jest.fn(async () => undefined),
    adReview: jest.fn(async () => review),
  } as unknown as jest.Mocked<CtwaGraph>;
}

let graph: jest.Mocked<CtwaGraph>;
let deps: Partial<CtwaDeps>;
const auth = jest.fn();
const priceToCheck = jest.fn();
const sign = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  doc = readyAd();
  clock = new Date("2026-11-04T05:00:00.000Z");
  made = { campaigns: [], adsets: [], adcreatives: [], ads: [], videos: [] };
  videoState = "processing";
  review = { effectiveStatus: "PAUSED", feedback: null };
  pageLinked = true;
  currency = "USD";
  counter = 0;
  graph = fakeGraph();
  auth.mockResolvedValue({ accessToken: "ads-token", adAccountId: "act_42" });
  priceToCheck.mockResolvedValue(false);
  sign.mockImplementation(async (_ws: string, file: { path: string } | null) =>
    file ? `https://signed.test/${file.path}` : null
  );
  deps = {
    graph,
    store,
    auth,
    sign,
    fetchBytes: async () => new Uint8Array([1, 2, 3]),
    priceToCheck,
    env: { PRODUCTS_CTWA_RUN_ENABLED: "1" },
    now: () => new Date(clock),
  };
});

const later = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
const create = (requestId = "press-1", asset: "video" | "picture" = "video") =>
  createCtwa({
    workspaceId: WS,
    adId: AD,
    request: { requestId, asset },
    deps,
  });
const poll = () => loadCtwa({ workspaceId: WS, adId: AD, deps });
/** An answer that isn't a refusal; a refusal fails the test. */
function answered<T extends object>(result: T | CtwaRefusal): T {
  if ("refused" in result) throw new Error(`Refused: ${result.refused}`);
  return result;
}
const run = (dailyBudgetCents = 100, days = 3) =>
  runCtwa({
    workspaceId: WS,
    adId: AD,
    request: { dailyBudgetCents, days },
    deps,
  });

/** Polls (3 s apart) until the ctwa is paused or failed, at most `times`. */
async function pollUntilSettled(times = 20) {
  for (let i = 0; i < times; i++) {
    const state = ctwaOf()?.state;
    if (state === "paused" || state === "failed") return;
    later(3_000);
    await poll();
  }
}

// ---------------------------------------------------------------------------

describe("Run's caps", () => {
  it("are off, at $1 a day for 3 days, when nothing is set", () => {
    expect(productsCtwaRunCaps({})).toEqual({
      enabled: false,
      maxDailyCents: 100,
      maxDays: 3,
    });
  });

  it("follow the env, never below Meta's minimum, ignoring what isn't a number", () => {
    expect(
      productsCtwaRunCaps({
        PRODUCTS_CTWA_RUN_ENABLED: "1",
        PRODUCTS_CTWA_RUN_MAX_DAILY_CENTS: "300",
        PRODUCTS_CTWA_RUN_MAX_DAYS: "2",
      })
    ).toEqual({ enabled: true, maxDailyCents: 300, maxDays: 2 });
    expect(
      productsCtwaRunCaps({
        PRODUCTS_CTWA_RUN_ENABLED: "true",
        PRODUCTS_CTWA_RUN_MAX_DAILY_CENTS: "50",
        PRODUCTS_CTWA_RUN_MAX_DAYS: "-1",
      })
    ).toEqual({ enabled: false, maxDailyCents: 100, maxDays: 3 });
  });
});

describe("readiness", () => {
  it("is not connected without a Meta Ads token, never claiming Instagram placements", async () => {
    auth.mockResolvedValue(null);
    const ads = await ctwaReadiness(WS, deps);
    expect(ads).toEqual({
      connected: false,
      adAccountName: null,
      currency: null,
      pageName: null,
      pageHasWhatsApp: null,
      instagramPlacements: false,
      runEnabled: true,
      runMaxDailyCents: 100,
      runMaxDays: 3,
    });
    expect(graph.adAccountInfo).not.toHaveBeenCalled();
  });

  it("names the account and Page, and says whether the Page has WhatsApp", async () => {
    pageLinked = false;
    expect(await ctwaReadiness(WS, { ...deps, env: {} })).toEqual({
      connected: true,
      adAccountName: "Airi.chat",
      currency: "USD",
      pageName: "Airi.chat",
      pageHasWhatsApp: false,
      instagramPlacements: false,
      runEnabled: false,
      runMaxDailyCents: 100,
      runMaxDays: 3,
    });
    expect(graph.pageWhatsAppLinked).toHaveBeenCalledWith(
      "ads-token",
      "page-1",
      expect.anything()
    );
  });

  it("is not connected when Meta refuses the token, and still connected through a hiccup", async () => {
    graph.adAccountInfo.mockRejectedValueOnce(
      new MetaAdsGraphError({
        kind: "auth",
        code: 190,
        subcode: null,
        userMessage: "expired",
      })
    );
    expect((await ctwaReadiness(WS, deps)).connected).toBe(false);
    graph.adAccountInfo.mockRejectedValueOnce(new Error("socket hang up"));
    const hiccup = await ctwaReadiness(WS, deps);
    expect(hiccup).toMatchObject({ connected: true, pageHasWhatsApp: null });
  });

  it("never throws", async () => {
    auth.mockRejectedValue(new Error("Supabase down"));
    expect((await ctwaReadiness(WS, deps)).connected).toBe(false);
  });
});

describe("Create ad", () => {
  it("stores the first attempt at once, and the first poll uploads the video from a fresh signed link", async () => {
    const result = await create();
    expect(graph.uploadAdVideo).not.toHaveBeenCalled();
    expect(ctwaOf()).toMatchObject({ state: "video", videoId: null });
    later(3_000);
    await poll();
    expect(result).toEqual({
      ctwa: {
        attempt: 1,
        asset: "video",
        state: "video",
        effectiveStatus: null,
        adsManagerUrl: null,
        dailyBudgetCents: null,
        endsAt: null,
        errorCode: null,
        errorMessage: null,
        failedStep: null,
      },
      started: true,
    });
    expect(graph.uploadAdVideo).toHaveBeenCalledWith(
      { accessToken: "ads-token", adAccountId: "act_42" },
      {
        fileUrl: "https://signed.test/ads/ad.mp4",
        name: `airi-products-${AD}-1-video`,
      },
      expect.anything()
    );
    expect(ctwaOf()).toMatchObject({
      requestId: "press-1",
      videoId: "videos-1",
      adAccountId: "act_42",
      pageId: "page-1",
      renderNo: 2,
      leaseUntil: null,
    });
  });

  it("makes every step PAUSED once Meta processed the video, then reads the review", async () => {
    await create();
    later(3_000);
    await poll();
    expect(ctwaOf()?.state).toBe("video");
    videoState = "ready";
    later(3_000);
    const result = await poll();
    expect(result).toEqual({
      ctwa: expect.objectContaining({
        state: "paused",
        effectiveStatus: "PAUSED",
        adsManagerUrl:
          "https://adsmanager.facebook.com/adsmanager/manage/ads?act=42&selected_ad_ids=ads-5",
      }),
    });
    expect(made.campaigns.map(object => object.name)).toEqual([
      ctwaObjectName(AD, 1, "campaign"),
    ]);
    expect(graph.validateAdSet).toHaveBeenCalledTimes(1);
    expect(graph.validateAdSet.mock.invocationCallOrder[0]).toBeLessThan(
      graph.createAdSet.mock.invocationCallOrder[0]
    );
    expect(graph.createAdSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        campaignId: "campaigns-2",
        pageId: "page-1",
        dailyBudgetCents: 100,
        startTime: clock,
        endTime: new Date(clock.getTime() + 3 * 86_400_000),
      }),
      expect.anything()
    );
    expect(graph.createAdCreative).toHaveBeenCalledWith(
      expect.anything(),
      {
        name: ctwaObjectName(AD, 1, "creative"),
        pageId: "page-1",
        message: "Жаңа кеселер келді",
        headline: "Кеселер",
        media: {
          kind: "video",
          videoId: "videos-1",
          posterUrl: "https://signed.test/ads/poster.jpg",
        },
        welcome: { greeting: "Сәлем!", buyerMessage: "Жеткізу бар ма?" },
      },
      expect.anything()
    );
    expect(graph.createAdCreative).toHaveBeenCalledTimes(1);
    expect(graph.createAd).toHaveBeenCalledWith(
      expect.anything(),
      {
        name: ctwaObjectName(AD, 1, "ad"),
        adSetId: "adsets-3",
        creativeId: "adcreatives-4",
      },
      expect.anything()
    );
    // Nothing was switched on.
    expect(graph.setObjectStatus).not.toHaveBeenCalled();

    // The review state is read again at most every 20 s.
    review = { effectiveStatus: "IN_PROCESS", feedback: null };
    later(5_000);
    await poll();
    expect(graph.adReview).not.toHaveBeenCalled();
    later(20_000);
    expect(answered(await poll()).ctwa).toMatchObject({
      effectiveStatus: "IN_PROCESS",
    });
  });

  it("makes the picture ad from the In a room still, its hash uploaded", async () => {
    await create("press-1", "picture");
    await pollUntilSettled();
    expect(sign).toHaveBeenCalledWith(WS, ref("ads/room-p1.jpg"));
    expect(graph.uploadAdVideo).not.toHaveBeenCalled();
    expect(graph.createAdCreative).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        media: { kind: "picture", imageHash: "image-hash-1" },
      }),
      expect.anything()
    );
    expect(ctwaOf()).toMatchObject({
      state: "paused",
      imageHash: "image-hash-1",
    });
  });

  it("falls back to the Studio still, then v2's feed still, for the picture", async () => {
    doc = readyAd({
      stillSet: {
        renderNo: 2,
        items: [
          {
            kind: "studio",
            format: "feed",
            productId: "p1",
            colourway: "sand",
            ref: ref("ads/studio-p1.jpg"),
          },
        ],
      },
    });
    await create("press-1", "picture");
    await poll();
    expect(sign).toHaveBeenCalledWith(WS, ref("ads/studio-p1.jpg"));
    doc = readyAd({ stillSet: { renderNo: 1, items: [] } });
    sign.mockClear();
    await create("press-1", "picture");
    await poll();
    expect(sign).toHaveBeenCalledWith(WS, ref("ads/feed-v2.jpg"));
  });

  it("answers a repeated press, a making one or a paused one of the same video as it is", async () => {
    await create();
    expect(answered(await create()).started).toBe(false);
    expect(answered(await create("press-2")).started).toBe(false);
    videoState = "ready";
    await pollUntilSettled();
    expect(answered(await create("press-3")).started).toBe(false);
    expect(graph.uploadAdVideo).toHaveBeenCalledTimes(1);
    expect(made.campaigns).toHaveLength(1);
  });

  it("starts the next attempt for a new video, keeping the paused one at Meta", async () => {
    videoState = "ready";
    await create();
    await pollUntilSettled();
    doc!.render = { ...doc!.render!, renderNo: 3, video: ref("ads/ad-3.mp4") };
    const result = await create("press-2");
    expect(result).toMatchObject({ started: true, ctwa: { attempt: 2 } });
    await poll();
    expect(graph.uploadAdVideo).toHaveBeenLastCalledWith(
      expect.anything(),
      {
        fileUrl: "https://signed.test/ads/ad-3.mp4",
        name: `airi-products-${AD}-2-video`,
      },
      expect.anything()
    );
  });

  it.each([
    ["the ad isn't there", () => (doc = null), "ad_not_found", 404],
    [
      "the ad is being made",
      () => (doc!.status = "making"),
      "ad_not_ready",
      409,
    ],
    [
      "the video has no poster",
      () => (doc!.render!.poster = null),
      "ad_not_ready",
      409,
    ],
    [
      "a price needs checking",
      () => priceToCheck.mockResolvedValue(true),
      "price_to_check",
      409,
    ],
    [
      "Meta Ads isn't connected",
      () => auth.mockResolvedValue(null),
      "ads_not_connected",
      409,
    ],
    [
      "the Page has no WhatsApp",
      () => (pageLinked = false),
      "page_whatsapp_missing",
      409,
    ],
    [
      "the account has no Page",
      () => graph.promotablePages.mockResolvedValue([]),
      "page_whatsapp_missing",
      409,
    ],
    [
      "the account isn't in US dollars",
      () => (currency = "KZT"),
      "budget_refused",
      409,
    ],
  ])(
    "refuses before storing anything when %s",
    async (_why, arrange, code, status) => {
      arrange();
      expect(await create()).toMatchObject({ refused: code, status });
      expect(doc?.meta?.ctwa ?? null).toBeNull();
      expect(graph.uploadAdVideo).not.toHaveBeenCalled();
    }
  );

  it("refuses a token Meta rejects as not connected, and Meta's hiccup as 503", async () => {
    graph.adAccountInfo.mockRejectedValueOnce(
      new MetaAdsGraphError({
        kind: "auth",
        code: 190,
        subcode: null,
        userMessage: "expired",
      })
    );
    expect(await create()).toMatchObject({
      refused: "ads_not_connected",
      status: 409,
    });
    graph.adAccountInfo.mockRejectedValueOnce(new Error("timeout"));
    expect(await create()).toMatchObject({
      refused: "ctwa_failed",
      status: 503,
    });
  });

  it("lets an unknown WhatsApp link through, for the ad set's own check", async () => {
    pageLinked = null;
    expect(await create()).toMatchObject({ started: true });
  });
});

describe("resuming", () => {
  const steps = [
    ["campaign", "createCampaign"],
    ["adset", "createAdSet"],
    ["creative", "createAdCreative"],
    ["ad", "createAd"],
  ] as const;

  it.each(steps)(
    "after Meta refused the %s step, Try again resumes there without making the earlier objects twice",
    async (state, call) => {
      videoState = "ready";
      const refusal = new MetaAdsGraphError({
        kind: "refused",
        code: 100,
        subcode: null,
        userMessage: "Meta says no.",
      });
      graph[call].mockRejectedValueOnce(refusal);
      // The creative is asked once more without its greeting.
      if (call === "createAdCreative")
        graph[call].mockRejectedValueOnce(refusal);
      await create();
      await pollUntilSettled();
      expect(ctwaOf()).toMatchObject({
        state: "failed",
        errorCode: "ctwa_failed",
        errorMessage: "Meta says no.",
      });
      const before = {
        videos: made.videos.length,
        campaigns: made.campaigns.length,
        adsets: made.adsets.length,
        adcreatives: made.adcreatives.length,
      };

      const retried = await create("press-2");
      expect(retried).toMatchObject({ started: true, ctwa: { attempt: 1 } });
      await pollUntilSettled();
      expect(ctwaOf()).toMatchObject({
        state: "paused",
        attempt: 1,
        errorCode: null,
      });
      expect(made.videos).toHaveLength(before.videos);
      if (state !== "campaign")
        expect(made.campaigns).toHaveLength(before.campaigns);
      if (state === "creative" || state === "ad")
        expect(made.adsets).toHaveLength(before.adsets);
      if (state === "ad")
        expect(made.adcreatives).toHaveLength(before.adcreatives);
      for (const edge of ["campaigns", "adsets", "adcreatives", "ads"] as const)
        expect(made[edge]).toHaveLength(1);
    }
  );

  it.each(steps)(
    "finds the %s Meta made when its answer was lost, never making it twice",
    async (_state, call) => {
      videoState = "ready";
      const mock = graph[call] as unknown as jest.Mock<
        Promise<string>,
        unknown[]
      >;
      const real = mock.getMockImplementation()!;
      mock.mockImplementationOnce(async (...args: unknown[]) => {
        await real(...args);
        throw new Error("timeout");
      });
      await create();
      await pollUntilSettled();
      expect(ctwaOf()?.state).toBe("paused");
      for (const edge of ["campaigns", "adsets", "adcreatives", "ads"] as const)
        expect(made[edge]).toHaveLength(1);
    }
  );

  it("finds an uploaded video whose answer was lost", async () => {
    graph.uploadAdVideo.mockImplementationOnce(async (_auth, params) => {
      created("videos", params.name);
      throw new Error("timeout");
    });
    await create();
    await poll();
    expect(graph.uploadAdVideo).toHaveBeenCalledTimes(1);
    expect(ctwaOf()).toMatchObject({ state: "video", videoId: null });
    videoState = "ready";
    await pollUntilSettled();
    expect(ctwaOf()).toMatchObject({ state: "paused", videoId: "videos-1" });
    expect(graph.uploadAdVideo).toHaveBeenCalledTimes(1);
    expect(made.videos).toHaveLength(1);
  });

  it("keeps a timed-out create leased while Meta's write is not visible yet", async () => {
    videoState = "ready";
    let delayedName = "";
    graph.createCampaign.mockImplementationOnce(async (_auth, params) => {
      delayedName = params.name;
      throw new Error("request timed out while Meta is still creating");
    });
    await create();
    await poll(); // Upload the video.
    later(3_000);
    await poll(); // The campaign create times out.
    const heldUntil = ctwaOf()!.leaseUntil!;
    expect(heldUntil.getTime()).toBe(clock.getTime() + 30_000);
    expect(made.campaigns).toHaveLength(0);

    later(3_000);
    await poll();
    expect(graph.createCampaign).toHaveBeenCalledTimes(1);
    expect(ctwaOf()!.leaseUntil).toEqual(heldUntil);

    created("campaigns", delayedName); // The original write finally lands.
    later(30_000);
    await pollUntilSettled();
    expect(ctwaOf()).toMatchObject({ state: "paused", leaseUntil: null });
    expect(graph.createCampaign).toHaveBeenCalledTimes(1);
    expect(made.campaigns).toHaveLength(1);
  });

  it("stores page_whatsapp_missing when the ad set's check is refused for WhatsApp", async () => {
    videoState = "ready";
    graph.validateAdSet.mockRejectedValueOnce(
      new MetaAdsGraphError({
        kind: "whatsapp",
        code: 100,
        subcode: 2446885,
        userMessage: "Connect a WhatsApp account to your Page.",
      })
    );
    await create();
    await pollUntilSettled();
    expect(ctwaOf()).toMatchObject({
      state: "failed",
      errorCode: "page_whatsapp_missing",
      errorMessage: "Connect a WhatsApp account to your Page.",
      campaignId: "campaigns-2",
      adSetId: null,
    });
    expect(graph.createAdSet).not.toHaveBeenCalled();
  });

  it("makes the creative again without the greeting when Meta refuses it, once", async () => {
    videoState = "ready";
    graph.createAdCreative.mockRejectedValueOnce(
      new MetaAdsGraphError({
        kind: "refused",
        code: 100,
        subcode: null,
        userMessage: "Invalid page_welcome_message for WhatsApp destination.",
      })
    );
    await create();
    await pollUntilSettled();
    expect(ctwaOf()?.state).toBe("paused");
    expect(graph.createAdCreative).toHaveBeenCalledTimes(2);
    expect(graph.createAdCreative.mock.calls[1][1].welcome).toBeNull();

    // Refused without it too: Meta's words land on the ad.
    graph.createAdCreative.mockReset();
    graph.createAdCreative.mockRejectedValue(
      new MetaAdsGraphError({
        kind: "refused",
        code: 100,
        subcode: null,
        userMessage: "The video is too short.",
      })
    );
    doc = readyAd();
    made = { campaigns: [], adsets: [], adcreatives: [], ads: [], videos: [] };
    await create("press-2");
    await pollUntilSettled();
    expect(ctwaOf()).toMatchObject({
      state: "failed",
      errorMessage: "The video is too short.",
    });
    expect(graph.createAdCreative).toHaveBeenCalledTimes(2);
  });

  it("leaves the greeting to Meta when the script has no question", async () => {
    videoState = "ready";
    doc!.script!.ctwa.questions = [];
    await create();
    await pollUntilSettled();
    expect(graph.createAdCreative.mock.calls[0][1].welcome).toBeNull();
  });

  it("stores ads_not_connected when the token stops working mid-way", async () => {
    videoState = "ready";
    graph.createCampaign.mockRejectedValueOnce(
      new MetaAdsGraphError({
        kind: "auth",
        code: 190,
        subcode: null,
        userMessage: "Session expired.",
      })
    );
    await create();
    await pollUntilSettled();
    expect(ctwaOf()).toMatchObject({
      state: "failed",
      errorCode: "ads_not_connected",
    });
  });

  it("waits through Meta's hiccups without storing a failure", async () => {
    videoState = "ready";
    graph.createCampaign.mockRejectedValueOnce(new Error("socket hang up"));
    await create();
    later(3_000);
    await poll(); // the upload
    later(3_000);
    await poll(); // processed; the campaign hiccups
    expect(ctwaOf()).toMatchObject({ state: "campaign", errorCode: null });
    expect(graph.createCampaign).toHaveBeenCalledTimes(1);
    await pollUntilSettled();
    expect(ctwaOf()?.state).toBe("paused");
  });

  it("fails a video Meta couldn't process, and uploads it again as the next attempt", async () => {
    await create();
    videoState = "error";
    await pollUntilSettled();
    expect(ctwaOf()).toMatchObject({
      state: "failed",
      errorCode: "ctwa_failed",
      errorMessage: "Meta couldn't process the video: Bad codec",
      videoId: null,
    });
    videoState = "ready";
    expect(await create("press-2")).toMatchObject({ ctwa: { attempt: 2 } });
    await poll();
    expect(graph.uploadAdVideo).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ name: `airi-products-${AD}-2-video` }),
      expect.anything()
    );
  });

  it("fails an ad still making after 20 minutes", async () => {
    await create();
    later(21 * 60_000);
    await poll();
    expect(ctwaOf()).toMatchObject({
      state: "failed",
      errorCode: "ctwa_failed",
    });
  });

  it("leaves a ctwa another poll holds alone", async () => {
    await create();
    ctwaOf()!.leaseUntil = new Date(clock.getTime() + 10_000);
    videoState = "ready";
    graph.adVideoStatus.mockClear();
    expect(answered(await poll()).ctwa?.state).toBe("video");
    expect(graph.adVideoStatus).not.toHaveBeenCalled();
  });

  it("answers null when no WhatsApp ad was asked for, and 404 for no ad", async () => {
    expect(await poll()).toEqual({ ctwa: null });
    doc = null;
    expect(await poll()).toMatchObject({
      refused: "ad_not_found",
      status: 404,
    });
  });

  it("fails a disapproved ad, and Create ad then starts the next attempt", async () => {
    videoState = "ready";
    await create();
    await pollUntilSettled();
    review = { effectiveStatus: "DISAPPROVED", feedback: "Misleading claims." };
    later(30_000);
    await poll();
    expect(ctwaOf()).toMatchObject({
      state: "failed",
      effectiveStatus: "DISAPPROVED",
      errorMessage: "Meta didn't approve the ad: Misleading claims.",
    });
    expect(await create("press-2")).toMatchObject({
      ctwa: { attempt: 2, state: "video" },
    });
  });
});

describe("Run", () => {
  async function paused() {
    videoState = "ready";
    await create();
    await pollUntilSettled();
    expect(ctwaOf()?.state).toBe("paused");
  }

  it("is refused while PRODUCTS_CTWA_RUN_ENABLED isn't 1", async () => {
    await paused();
    deps.env = {};
    expect(await run()).toEqual({ refused: "run_disabled", status: 409 });
    expect(graph.setObjectStatus).not.toHaveBeenCalled();
  });

  it.each([
    [101, 3],
    [100, 4],
    [500, 7],
  ])(
    "refuses %i cents for %i days above the server's caps",
    async (cents, days) => {
      await paused();
      expect(await run(cents, days)).toEqual({
        refused: "budget_refused",
        status: 409,
      });
      expect(graph.setAdSetBudget).not.toHaveBeenCalled();
    }
  );

  it("refuses less than $1 a day or a day", async () => {
    await paused();
    expect(await run(99, 3)).toMatchObject({
      refused: "invalid_request",
      status: 400,
    });
    expect(await run(100, 0)).toMatchObject({
      refused: "invalid_request",
      status: 400,
    });
  });

  it("follows the env's caps", async () => {
    await paused();
    deps.env = {
      PRODUCTS_CTWA_RUN_ENABLED: "1",
      PRODUCTS_CTWA_RUN_MAX_DAILY_CENTS: "300",
      PRODUCTS_CTWA_RUN_MAX_DAYS: "2",
    };
    expect(await run(300, 3)).toMatchObject({ refused: "budget_refused" });
    expect(await run(300, 2)).toMatchObject({
      ctwa: { state: "running", dailyBudgetCents: 300 },
    });
  });

  it("sets the budget and end, then switches the ad, the ad set and last the campaign on", async () => {
    await paused();
    review = { effectiveStatus: "PENDING_REVIEW", feedback: null };
    const result = await run(100, 3);
    const endsAt = new Date(clock.getTime() + 3 * 86_400_000);
    expect(result).toEqual({
      ctwa: expect.objectContaining({
        state: "running",
        dailyBudgetCents: 100,
        endsAt: endsAt.toISOString(),
        effectiveStatus: "PENDING_REVIEW",
        errorCode: null,
      }),
    });
    expect(graph.setAdSetBudget).toHaveBeenCalledWith(
      expect.anything(),
      "adsets-3",
      { dailyBudgetCents: 100, endTime: endsAt },
      expect.anything()
    );
    expect(
      graph.setObjectStatus.mock.calls.map(call => [call[1], call[2]])
    ).toEqual([
      ["ads-5", "ACTIVE"],
      ["adsets-3", "ACTIVE"],
      ["campaigns-2", "ACTIVE"],
    ]);
    expect(graph.setAdSetBudget.mock.invocationCallOrder[0]).toBeLessThan(
      graph.setObjectStatus.mock.invocationCallOrder[0]
    );
    expect(ctwaOf()).toMatchObject({ state: "running", leaseUntil: null });

    // Running answers as it is, and is never run again.
    expect(await run()).toMatchObject({ ctwa: { state: "running" } });
    expect(graph.setAdSetBudget).toHaveBeenCalledTimes(1);
    // Create ad leaves a running ad alone.
    expect(await create("press-9")).toMatchObject({
      started: false,
      ctwa: { state: "running" },
    });
  });

  it("keeps the ad paused when Meta refuses, switching the campaign off again", async () => {
    await paused();
    graph.setObjectStatus
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new MetaAdsGraphError({
          kind: "refused",
          code: 100,
          subcode: null,
          userMessage: "Ad set can't run.",
        })
      );
    const result = await run();
    expect(result).toMatchObject({
      ctwa: {
        state: "paused",
        errorCode: "ctwa_failed",
        errorMessage: "Ad set can't run.",
      },
    });
    expect(graph.setObjectStatus).toHaveBeenLastCalledWith(
      expect.anything(),
      "campaigns-2",
      "PAUSED",
      expect.anything()
    );
    // A later Run tries again.
    expect(await run()).toMatchObject({ ctwa: { state: "running" } });
  });

  it.each([
    ["ACTIVE", "running"],
    ["PENDING_REVIEW", "running"],
    ["CAMPAIGN_PAUSED", "paused"],
    ["PAUSED", "paused"],
  ] as const)(
    "keeps a lost activation and failed rollback unknown until Meta confirms %s",
    async (effectiveStatus, state) => {
      await paused();
      graph.setObjectStatus.mockImplementationOnce(async () => {
        // The durable fence precedes activation, including a process dying
        // before any response can be saved.
        expect(ctwaOf()).toMatchObject({
          state: "running",
          effectiveStatus: null,
          errorCode: "ctwa_failed",
        });
        throw new Error("activation answer lost");
      });
      graph.setObjectStatus.mockRejectedValueOnce(
        new Error("pause answer lost")
      );
      expect(await run()).toMatchObject({
        ctwa: {
          state: "running",
          effectiveStatus: null,
          errorCode: "ctwa_failed",
          errorMessage: expect.stringContaining("not confirmed"),
        },
      });
      expect(ctwaOf()!.leaseUntil).not.toBeNull();
      expect(ctwaOf()!.errorMessage).not.toContain("Nothing was spent");
      expect(ctwaOf()!.errorMessage).not.toContain("still paused");
      expect(await run()).toMatchObject({
        ctwa: { state: "running", effectiveStatus: null },
      });
      expect(graph.setAdSetBudget).toHaveBeenCalledTimes(1);

      review = { effectiveStatus, feedback: null };
      later(30_001);
      expect(await poll()).toMatchObject({
        ctwa: { state, effectiveStatus, errorCode: null, errorMessage: null },
      });
    }
  );

  it("does not claim no spend when a timed-out activation is successfully paused", async () => {
    await paused();
    graph.setObjectStatus.mockRejectedValueOnce(
      new Error("activation timed out")
    );
    expect(await run()).toMatchObject({
      ctwa: {
        state: "paused",
        effectiveStatus: "CAMPAIGN_PAUSED",
        errorMessage: expect.stringContaining(
          "Check Ads Manager for any delivery"
        ),
      },
    });
    expect(ctwaOf()!.errorMessage).not.toContain("Nothing was spent");
    expect(ctwaOf()!.leaseUntil).toBeNull();
  });

  it("does not activate when the pending state could not be persisted under its lease", async () => {
    await paused();
    const save = jest.spyOn(store, "save").mockResolvedValueOnce(false);
    try {
      expect(await run()).toEqual({ refused: "ad_not_ready", status: 409 });
      expect(graph.setAdSetBudget).not.toHaveBeenCalled();
      expect(graph.setObjectStatus).not.toHaveBeenCalled();
    } finally {
      save.mockRestore();
    }
  });

  it("gives switching its own timeout after a slow preflight", async () => {
    await paused();
    const preflight = new AbortController();
    const switching = new AbortController();
    const timeout = jest
      .spyOn(AbortSignal, "timeout")
      .mockReturnValueOnce(preflight.signal)
      .mockReturnValueOnce(switching.signal);
    graph.adAccountInfo.mockImplementationOnce(async (_auth, options) => {
      expect(options?.signal).toBe(preflight.signal);
      // The check finishes just as its allotted time expires.
      preflight.abort();
      return { name: "Airi.chat", currency: "USD" };
    });
    graph.setAdSetBudget.mockImplementationOnce(
      async (_auth, _id, _budget, options) => {
        expect(options?.signal).toBe(switching.signal);
        expect(options?.signal?.aborted).toBe(false);
      }
    );
    try {
      expect(await run()).toMatchObject({ ctwa: { state: "running" } });
      expect(timeout).toHaveBeenCalledTimes(2);
    } finally {
      timeout.mockRestore();
    }
  });

  it.each([
    ["no WhatsApp ad yet", async () => undefined, "ad_not_ready"],
    ["one still being made", async () => void (await create()), "ad_not_ready"],
  ])("is refused with %s", async (_why, arrange, code) => {
    await arrange();
    expect(await run()).toMatchObject({ refused: code, status: 409 });
  });

  it("waits once for a poll holding the ad, and never switches anything on while it can't hold it", async () => {
    await paused();
    ctwaOf()!.leaseUntil = new Date(clock.getTime() + 10_000);
    setTimeout(() => {
      ctwaOf()!.leaseUntil = null;
    }, 300);
    expect(await run()).toMatchObject({ ctwa: { state: "running" } });

    doc!.meta!.ctwa!.state = "paused";
    ctwaOf()!.leaseUntil = new Date(clock.getTime() + 10_000);
    graph.setObjectStatus.mockClear();
    expect(await run()).toMatchObject({ refused: "ad_not_ready", status: 409 });
    expect(graph.setObjectStatus).not.toHaveBeenCalled();
  });

  it("is refused on a red tag, without Meta Ads, or off US dollars", async () => {
    await paused();
    priceToCheck.mockResolvedValueOnce(true);
    expect(await run()).toMatchObject({ refused: "price_to_check" });
    auth.mockResolvedValueOnce(null);
    expect(await run()).toMatchObject({ refused: "ads_not_connected" });
    currency = "EUR";
    expect(await run()).toMatchObject({ refused: "budget_refused" });
    expect(graph.setObjectStatus).not.toHaveBeenCalled();
  });
});

describe("the record and the requests", () => {
  it("shows no ids, token or request id; links Ads Manager once the ad exists", () => {
    const stored: ProductAdStoredCtwa = {
      requestId: "press-1",
      attempt: 2,
      asset: "video",
      state: "running",
      videoId: "v",
      imageHash: null,
      campaignId: "c",
      adSetId: "s",
      creativeId: "cr",
      adId: "a",
      effectiveStatus: "ACTIVE",
      dailyBudgetCents: 100,
      endsAt: new Date("2026-11-07T05:00:00.000Z"),
      errorCode: null,
      errorMessage: null,
      requestedAt: new Date(),
      leaseUntil: null,
      adAccountId: "act_42",
      pageId: "page-1",
      renderNo: 2,
      checkedAt: null,
    };
    expect(toCtwaRecord(stored)).toEqual({
      attempt: 2,
      asset: "video",
      state: "running",
      effectiveStatus: "ACTIVE",
      adsManagerUrl:
        "https://adsmanager.facebook.com/adsmanager/manage/ads?act=42&selected_ad_ids=a",
      dailyBudgetCents: 100,
      endsAt: "2026-11-07T05:00:00.000Z",
      errorCode: null,
      errorMessage: null,
      failedStep: null,
    });
    expect(toCtwaRecord(null)).toBeNull();
    expect(
      toCtwaRecord({
        ...stored,
        state: "failed",
        adSetId: null,
        creativeId: null,
        adId: null,
      })?.failedStep
    ).toBe("adset");
    expect(
      toCtwaRecord({ ...stored, state: "failed", videoId: null })?.failedStep
    ).toBe("video");
    expect(toCtwaRecord({ ...stored, state: "failed" })?.failedStep).toBeNull();
  });

  it("parse only well-formed bodies", () => {
    expect(parseCtwaRequest({ requestId: "press-1", asset: "video" })).toEqual({
      requestId: "press-1",
      asset: "video",
    });
    expect(
      parseCtwaRequest({ requestId: "press-1", asset: "story" })
    ).toBeNull();
    expect(parseCtwaRequest({ requestId: "", asset: "video" })).toBeNull();
    expect(parseCtwaRequest(null)).toBeNull();
    expect(parseCtwaRunRequest({ dailyBudgetCents: 100, days: 3 })).toEqual({
      dailyBudgetCents: 100,
      days: 3,
    });
    expect(parseCtwaRunRequest({ dailyBudgetCents: 1.5, days: 3 })).toBeNull();
    expect(
      parseCtwaRunRequest({ dailyBudgetCents: "100", days: 3 })
    ).toBeNull();
  });
});
