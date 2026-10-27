import {
  buildTikTokMarketingTemplatesUrl,
  decodeTikTokMarketingTemplatesResponse,
  DEFAULT_TIKTOK_DISCOVERY_CATEGORY,
  DEFAULT_TIKTOK_DISCOVERY_MARKET,
  getTikTokDiscoveryPreferencesStorageKey,
  isTikTokDiscoveryCategory,
  isTikTokDiscoveryMarket,
  normalizeTikTokDiscoveryPreferences,
  TIKTOK_DISCOVERY_CATEGORIES,
  TIKTOK_DISCOVERY_MARKETS,
  type TikTokMarketingTemplatesResponse,
} from "./tiktok-marketing-templates";

type OkResponse = Extract<TikTokMarketingTemplatesResponse, { status: "ok" }>;

const expectedCoordinate = { market: "KZ", category: "ALL" } as const;

function okResponse(): OkResponse {
  return {
    status: "ok",
    items: [
      {
        id: "tiktok:video-1",
        source: "tiktok_discovery",
        title: "Restaurant transformation",
        preset: null,
        reference: {
          providerVideoId: "video-1",
          shareUrl: "https://www.tiktok.com/@creator/video/1",
          thumbnailUrl: "https://p16.muscdn.com/object/preview.jpg",
          creatorName: "Creator",
          creatorUrl: "https://www.tiktok.com/@creator",
          hashtag: "restaurant",
          hashtagRank: 1,
          videoRank: 2,
          market: "KZ",
          category: "ALL",
          windowDays: 7,
        },
      },
    ],
    market: "KZ",
    category: "ALL",
    windowDays: 7,
    updatedAt: "2026-08-13T12:00:00.000Z",
    stale: true,
    warning: "provider_unavailable",
  };
}

function responseWithItem(item: unknown): unknown {
  return { ...okResponse(), items: [item] };
}

describe("TikTok discovery catalog contract", () => {
  it("pins the official v1 coordinates without coercion", () => {
    expect(TIKTOK_DISCOVERY_MARKETS).toHaveLength(246);
    expect(TIKTOK_DISCOVERY_MARKETS[0]).toBe("AD");
    expect(TIKTOK_DISCOVERY_MARKETS.at(-1)).toBe("ZW");
    expect(new Set(TIKTOK_DISCOVERY_MARKETS).size).toBe(246);
    expect(["KZ", "UZ", "US"].every(isTikTokDiscoveryMarket)).toBe(true);
    expect(["kz", " KZ ", "ZZ"].some(isTikTokDiscoveryMarket)).toBe(false);
    expect(TIKTOK_DISCOVERY_CATEGORIES).toHaveLength(19);
    expect(new Set(TIKTOK_DISCOVERY_CATEGORIES).size).toBe(19);
    expect(TIKTOK_DISCOVERY_CATEGORIES).toEqual([
      "ALL",
      "APPAREL_AND_ACCESSORIES",
      "BABY_KIDS_AND_MATERNITY",
      "BEAUTY_AND_PERSONAL_CARE",
      "BUSINESS_SERVICES",
      "EDUCATION",
      "FINANCIAL_SERVICES",
      "FOOD_AND_BEVERAGE",
      "GAMES",
      "HEALTH",
      "HOME_IMPROVEMENT",
      "HOUSEHOLD_PRODUCTS",
      "LIFE_SERVICES",
      "NEWS_AND_ENTERTAINMENT",
      "PETS",
      "SPORTS_AND_OUTDOOR",
      "TECHNOLOGY",
      "TRAVEL",
      "VEHICLE_AND_TRANSPORTATION",
    ]);
    expect(isTikTokDiscoveryCategory("FOOD_AND_BEVERAGE")).toBe(true);
    expect(isTikTokDiscoveryCategory("food_and_beverage")).toBe(false);
    expect(DEFAULT_TIKTOK_DISCOVERY_MARKET).toBe("KZ");
    expect(DEFAULT_TIKTOK_DISCOVERY_CATEGORY).toBe("ALL");
  });

  it("normalizes each preference independently and builds a stable route", () => {
    expect(
      normalizeTikTokDiscoveryPreferences({ market: "UZ", category: "bad" })
    ).toEqual({
      market: "UZ",
      category: "ALL",
    });
    expect(getTikTokDiscoveryPreferencesStorageKey("workspace / 1")).toBe(
      "airi:assets:tiktok-discovery-preferences:v1:workspace / 1"
    );
    expect(
      buildTikTokMarketingTemplatesUrl({
        workspaceId: "workspace / 1",
        market: "KZ",
        category: "FOOD_AND_BEVERAGE",
      })
    ).toBe(
      "/api/workspaces/workspace%20%2F%201/assets/marketing-templates/tiktok?market=KZ&category=FOOD_AND_BEVERAGE"
    );
  });

  it("decodes every complete response variant into fresh plain data", () => {
    const responses: TikTokMarketingTemplatesResponse[] = [
      okResponse(),
      { status: "unavailable", items: [] },
      {
        status: "temporarily_unavailable",
        items: [],
        retryAt: "2026-08-13T12:00:30.000Z",
      },
      { status: "error", items: [], retryable: true },
    ];

    for (const response of responses) {
      const decoded = decodeTikTokMarketingTemplatesResponse(
        response,
        expectedCoordinate
      );
      expect(decoded).toEqual(response);
      expect(decoded).not.toBe(response);
      expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    }

    const decodedOk = decodeTikTokMarketingTemplatesResponse(
      responses[0],
      expectedCoordinate
    );
    expect(decodedOk?.status).toBe("ok");
    if (decodedOk?.status === "ok") {
      expect(decodedOk.items).not.toBe(responses[0].items);
      expect(decodedOk.items[0]).not.toBe(responses[0].items[0]);
      expect(decodedOk.items[0].reference).not.toBe(
        responses[0].items[0].reference
      );
    }
  });

  it.each([
    ["an array", () => []],
    ["an unknown status", () => ({ status: "pending", items: [] })],
    ["an extra top-level key", () => ({ ...okResponse(), secret: "value" })],
    [
      "a custom prototype",
      () => Object.setPrototypeOf(okResponse(), { polluted: true }),
    ],
    [
      "mismatched requested coordinates",
      () => ({ ...okResponse(), market: "UZ" }),
    ],
    ["a non-seven-day window", () => ({ ...okResponse(), windowDays: 30 })],
    [
      "a non-canonical timestamp",
      () => ({ ...okResponse(), updatedAt: "2026-08-13T12:00:00Z" }),
    ],
    [
      "an unsupported warning",
      () => ({ ...okResponse(), warning: "raw_provider_error" }),
    ],
    [
      "an explicitly undefined warning",
      () => ({ ...okResponse(), warning: undefined }),
    ],
    [
      "more than twelve items",
      () => ({
        ...okResponse(),
        items: Array.from({ length: 13 }, (_, index) => {
          const item = okResponse().items[0];
          const providerVideoId = `video-${index}`;
          return {
            ...item,
            id: `tiktok:${providerVideoId}`,
            reference: { ...item.reference, providerVideoId },
          };
        }),
      }),
    ],
  ] as const)("rejects %s at the response boundary", (_name, buildValue) => {
    expect(
      decodeTikTokMarketingTemplatesResponse(buildValue(), expectedCoordinate)
    ).toBeNull();
  });

  it.each([
    ["an array reference", () => []],
    [
      "an extra item key",
      () => ({ ...okResponse().items[0], providerPayload: true }),
    ],
    [
      "a forged preset",
      () => ({ ...okResponse().items[0], preset: { id: "forged" } }),
    ],
    [
      "a mismatched item ID",
      () => ({ ...okResponse().items[0], id: "tiktok:other" }),
    ],
    [
      "an unsafe provider video ID",
      () => ({
        ...okResponse().items[0],
        id: "tiktok:video/1",
        reference: {
          ...okResponse().items[0].reference,
          providerVideoId: "video/1",
        },
      }),
    ],
    [
      "an oversized title",
      () => ({ ...okResponse().items[0], title: "t".repeat(501) }),
    ],
    [
      "a non-TikTok share URL",
      () => ({
        ...okResponse().items[0],
        reference: {
          ...okResponse().items[0].reference,
          shareUrl: "https://www.tiktok.com.evil.example/video/1",
        },
      }),
    ],
    [
      "an unapproved thumbnail host",
      () => ({
        ...okResponse().items[0],
        reference: {
          ...okResponse().items[0].reference,
          thumbnailUrl: "https://evil.example/thumbnail.jpg",
        },
      }),
    ],
    [
      "a non-TikTok creator URL",
      () => ({
        ...okResponse().items[0],
        reference: {
          ...okResponse().items[0].reference,
          creatorUrl: "https://evil.example/@creator",
        },
      }),
    ],
    [
      "oversized creator text",
      () => ({
        ...okResponse().items[0],
        reference: {
          ...okResponse().items[0].reference,
          creatorName: "c".repeat(129),
        },
      }),
    ],
    [
      "oversized hashtag text",
      () => ({
        ...okResponse().items[0],
        reference: {
          ...okResponse().items[0].reference,
          hashtag: "h".repeat(201),
        },
      }),
    ],
    [
      "a zero rank",
      () => ({
        ...okResponse().items[0],
        reference: { ...okResponse().items[0].reference, hashtagRank: 0 },
      }),
    ],
    [
      "a rank above the provider bound",
      () => ({
        ...okResponse().items[0],
        reference: { ...okResponse().items[0].reference, videoRank: 1_001 },
      }),
    ],
    [
      "mismatched nested coordinates",
      () => ({
        ...okResponse().items[0],
        reference: { ...okResponse().items[0].reference, market: "UZ" },
      }),
    ],
  ] as const)("rejects an item with %s", (_name, buildItem) => {
    expect(
      decodeTikTokMarketingTemplatesResponse(
        responseWithItem(buildItem()),
        expectedCoordinate
      )
    ).toBeNull();
  });

  it.each([
    ["non-empty unavailable items", { status: "unavailable", items: [{}] }],
    [
      "an invalid retry deadline",
      { status: "temporarily_unavailable", items: [], retryAt: "soon" },
    ],
    [
      "an extra temporary field",
      { status: "temporarily_unavailable", items: [], retryable: true },
    ],
    [
      "a truthy retryable value",
      { status: "error", items: [], retryable: "yes" },
    ],
  ] as const)("rejects non-OK response with %s", (_name, response) => {
    expect(
      decodeTikTokMarketingTemplatesResponse(response, expectedCoordinate)
    ).toBeNull();
  });
});
