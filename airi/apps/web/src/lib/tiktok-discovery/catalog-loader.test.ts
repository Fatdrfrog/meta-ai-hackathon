import { BoundedJsonResponseError } from "@/lib/http/bounded-json-response";
import {
  TikTokBusinessApiError,
  type TikTokOEmbedMetadata,
} from "@/lib/tiktok-discovery/business-api-client";
import {
  buildTikTokDiscoveryCacheKeys,
  loadTikTokDiscoveryMarketingTemplates,
  type TikTokDiscoveryCacheEnvelope,
  type TikTokDiscoveryCacheStore,
  type TikTokDiscoveryCooldownEnvelope,
  type TikTokDiscoveryDependencies,
} from "./catalog-loader";

const GENERATION = "a".repeat(32);
const values = new Map<string, unknown>();
const writes: Array<{ key: string; value: unknown; ttl: number }> = [];
const cacheStore: TikTokDiscoveryCacheStore = {
  readWithStatus: jest.fn(async <T>(key: string) => {
    return values.has(key)
      ? { status: "hit" as const, value: values.get(key) as T }
      : { status: "miss" as const };
  }) as TikTokDiscoveryCacheStore["readWithStatus"],
  writeWithStatus: jest.fn(async (key: string, value: unknown, ttl = 30) => {
    values.set(key, value);
    writes.push({ key, value, ttl });
    return "stored" as const;
  }),
  acquireLock: jest.fn(async () => "acquired" as const),
  compareAndDelete: jest.fn(async () => true),
  publishIfLockOwned: jest.fn(async ({ valueKey, value, ttlSeconds }) => {
    values.set(valueKey, value);
    writes.push({ key: valueKey, value, ttl: ttlSeconds });
    return "published" as const;
  }),
};
const dependencies: TikTokDiscoveryDependencies = {
  cacheStore,
  resolveAppIdentity: jest.fn(() => ({
    status: "configured" as const,
    appId: "app-1",
  })),
  resolveCredentialCoordinate: jest.fn(async () => ({
    status: "connected" as const,
    generation: GENERATION,
    advertiserId: "101",
  })),
  loadCredentialForGeneration: jest.fn(async () => ({
    status: "ready" as const,
    generation: GENERATION,
    advertiserId: "101",
    accessToken: "secret-token",
  })),
  acquireProviderPermit: jest.fn(async () => ({
    permit: "granted" as const,
    retryAt: null,
  })),
  fetchTrendingHashtags: jest.fn(async () => ({
    requestId: "trending-request",
    hashtags: [
      { id: "rank-1", name: "one", rank: 1, topCountryList: ["US" as const] },
      { id: "rank-2", name: "two", rank: 2, topCountryList: ["KZ" as const] },
      {
        id: "rank-4",
        name: "four",
        rank: 4,
        topCountryList: ["KZ" as const],
      },
    ],
  })),
  fetchTrendingVideos: jest.fn(async () => ({
    requestId: "video-request",
    groups: [
      {
        hashtagId: "rank-2",
        videos: [
          {
            videoId: "video-1",
            shareUrl: "https://www.tiktok.com/@creator/video/1",
            rank: 1,
          },
        ],
      },
      { hashtagId: "rank-4", videos: [] },
    ],
  })),
  fetchOEmbed: jest.fn(async () => ({
    title: "Food reveal",
    authorName: "Creator",
    authorUrl: "https://www.tiktok.com/@creator",
    thumbnailUrl: "https://p16.muscdn.com/object/preview",
  })),
  markCredentialValidatedAndPublish: jest.fn(async () => "published" as const),
  markCredentialFailureAndPublish: jest.fn(async () => "published" as const),
};
const expectedCacheKeys = buildTikTokDiscoveryCacheKeys({
  developerAppId: "app-1",
  generation: GENERATION,
  advertiserId: "101",
  market: "KZ",
  category: "ALL",
});
const expectedCatalogKey = expectedCacheKeys.catalog;

function catalogEnvelope(
  overrides: Partial<TikTokDiscoveryCacheEnvelope> = {}
): TikTokDiscoveryCacheEnvelope {
  return {
    schemaVersion: 1,
    apiVersion: "v1.3",
    generation: GENERATION,
    advertiserId: "101",
    market: "KZ",
    category: "ALL",
    windowDays: 7,
    items: [
      {
        id: "tiktok:cached-video",
        source: "tiktok_discovery",
        title: "Cached trend",
        preset: null,
        reference: {
          providerVideoId: "cached-video",
          shareUrl: "https://www.tiktok.com/@creator/video/cached-video",
          thumbnailUrl: null,
          creatorName: null,
          creatorUrl: null,
          hashtag: "cached",
          hashtagRank: 1,
          videoRank: 1,
          market: "KZ",
          category: "ALL",
          windowDays: 7,
        },
      },
    ],
    updatedAt: "2026-08-13T11:00:00.000Z",
    refreshedAt: "2026-08-13T11:00:00.000Z",
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForCall(mock: jest.Mock): Promise<void> {
  for (
    let attempt = 0;
    attempt < 50 && mock.mock.calls.length === 0;
    attempt += 1
  ) {
    await Promise.resolve();
  }
  expect(mock).toHaveBeenCalledTimes(1);
}

beforeEach(() => {
  values.clear();
  writes.splice(0);
  (cacheStore.readWithStatus as jest.Mock)
    .mockReset()
    .mockImplementation(async (key: string) =>
      values.has(key)
        ? { status: "hit", value: values.get(key) }
        : { status: "miss" }
    );
  (cacheStore.writeWithStatus as jest.Mock)
    .mockReset()
    .mockImplementation(async (key: string, value: unknown, ttl = 30) => {
      values.set(key, value);
      writes.push({ key, value, ttl });
      return "stored";
    });
  (cacheStore.acquireLock as jest.Mock)
    .mockReset()
    .mockResolvedValue("acquired");
  (cacheStore.compareAndDelete as jest.Mock)
    .mockReset()
    .mockResolvedValue(true);
  (cacheStore.publishIfLockOwned as jest.Mock)
    .mockReset()
    .mockImplementation(async ({ valueKey, value, ttlSeconds }) => {
      values.set(valueKey, value);
      writes.push({ key: valueKey, value, ttl: ttlSeconds });
      return "published";
    });
  (dependencies.resolveAppIdentity as jest.Mock)
    .mockReset()
    .mockReturnValue({ status: "configured", appId: "app-1" });
  (dependencies.resolveCredentialCoordinate as jest.Mock)
    .mockReset()
    .mockResolvedValue({
      status: "connected",
      generation: GENERATION,
      advertiserId: "101",
    });
  (dependencies.loadCredentialForGeneration as jest.Mock)
    .mockReset()
    .mockResolvedValue({
      status: "ready",
      generation: GENERATION,
      advertiserId: "101",
      accessToken: "secret-token",
    });
  (dependencies.acquireProviderPermit as jest.Mock)
    .mockReset()
    .mockResolvedValue({ permit: "granted", retryAt: null });
  (dependencies.fetchTrendingHashtags as jest.Mock)
    .mockReset()
    .mockResolvedValue({
      requestId: "trending-request",
      hashtags: [
        { id: "rank-1", name: "one", rank: 1, topCountryList: ["US"] },
        { id: "rank-2", name: "two", rank: 2, topCountryList: ["KZ"] },
        { id: "rank-4", name: "four", rank: 4, topCountryList: ["KZ"] },
      ],
    });
  (dependencies.fetchTrendingVideos as jest.Mock)
    .mockReset()
    .mockResolvedValue({
      requestId: "video-request",
      groups: [
        {
          hashtagId: "rank-2",
          videos: [
            {
              videoId: "video-1",
              shareUrl: "https://www.tiktok.com/@creator/video/1",
              rank: 1,
            },
          ],
        },
        { hashtagId: "rank-4", videos: [] },
      ],
    });
  (dependencies.fetchOEmbed as jest.Mock).mockReset().mockResolvedValue({
    title: "Food reveal",
    authorName: "Creator",
    authorUrl: "https://www.tiktok.com/@creator",
    thumbnailUrl: "https://p16.muscdn.com/object/preview",
  });
  (dependencies.markCredentialValidatedAndPublish as jest.Mock)
    .mockReset()
    .mockResolvedValue("published");
  (dependencies.markCredentialFailureAndPublish as jest.Mock)
    .mockReset()
    .mockResolvedValue("published");
});

it.each([
  [{ status: "server_unconfigured" }, 200, "unavailable"],
  [{ status: "unavailable" }, 200, "unavailable"],
  [
    {
      status: "reconnect_required",
      generation: GENERATION,
      advertiserId: "101",
    },
    200,
    "temporarily_unavailable",
  ],
  [{ status: "infrastructure_unavailable" }, 503, "temporarily_unavailable"],
] as const)(
  "maps credential coordinate %#",
  async (coordinate, transport, product) => {
    if (coordinate.status === "server_unconfigured") {
      (dependencies.resolveAppIdentity as jest.Mock).mockReturnValue(
        coordinate
      );
    } else {
      (dependencies.resolveCredentialCoordinate as jest.Mock).mockResolvedValue(
        coordinate
      );
    }
    const result = await loadTikTokDiscoveryMarketingTemplates(
      { market: "KZ", category: "ALL" },
      dependencies
    );
    expect(result.transportStatus).toBe(transport);
    expect(result.response.status).toBe(product);
    expect(dependencies.loadCredentialForGeneration).not.toHaveBeenCalled();
    expect(dependencies.fetchTrendingHashtags).not.toHaveBeenCalled();
  }
);

it.each([
  "changed",
  "unavailable",
  "reconnect_required",
  "infrastructure_unavailable",
] as const)(
  "maps refresh credential state %s without provider access",
  async status => {
    (dependencies.loadCredentialForGeneration as jest.Mock).mockResolvedValue({
      status,
    });
    const result = await loadTikTokDiscoveryMarketingTemplates(
      { market: "KZ", category: "ALL" },
      dependencies
    );
    expect(dependencies.fetchTrendingHashtags).not.toHaveBeenCalled();
    expect(result.transportStatus).toBe(
      status === "infrastructure_unavailable" ? 503 : 200
    );
  }
);

it("batches the first eligible ranked hashtags and publishes a fenced catalog", async () => {
  const foodKeys = buildTikTokDiscoveryCacheKeys({
    developerAppId: "app-1",
    generation: GENERATION,
    advertiserId: "101",
    market: "KZ",
    category: "FOOD_AND_BEVERAGE",
  });
  const result = await loadTikTokDiscoveryMarketingTemplates(
    {
      market: "KZ",
      category: "FOOD_AND_BEVERAGE",
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    },
    dependencies
  );
  expect(dependencies.fetchTrendingVideos).toHaveBeenCalledTimes(1);
  expect(dependencies.fetchTrendingVideos).toHaveBeenCalledWith(
    expect.objectContaining({
      hashtagIds: ["rank-2", "rank-4"],
      market: "KZ",
    })
  );
  expect(result.response).toMatchObject({
    status: "ok",
    stale: false,
    market: "KZ",
    category: "FOOD_AND_BEVERAGE",
    items: [
      {
        id: "tiktok:video-1",
        title: "Food reveal",
        preset: null,
        reference: {
          hashtag: "two",
          hashtagRank: 2,
          videoRank: 1,
          windowDays: 7,
        },
      },
    ],
  });
  expect(writes).toContainEqual(expect.objectContaining({ ttl: 86_400 }));
  expect(JSON.stringify(writes)).not.toContain("secret-token");
  expect(dependencies.markCredentialValidatedAndPublish).toHaveBeenCalledWith(
    expect.objectContaining({ generation: GENERATION })
  );
  expect(cacheStore.acquireLock).toHaveBeenCalledWith(
    foodKeys.refreshLock,
    expect.any(String),
    240
  );
  const refreshOwner = (cacheStore.acquireLock as jest.Mock).mock.calls[0][1];
  expect(cacheStore.publishIfLockOwned).toHaveBeenCalledWith({
    lockKey: foodKeys.refreshLock,
    ownerToken: refreshOwner,
    valueKey: foodKeys.catalog,
    value: expect.objectContaining({
      generation: GENERATION,
      market: "KZ",
      category: "FOOD_AND_BEVERAGE",
    }),
    ttlSeconds: 86_400,
  });
  expect(cacheStore.compareAndDelete).not.toHaveBeenCalled();
});

it.each([
  [29 * 60 + 59, "fresh"],
  [30 * 60, "stale"],
  [24 * 60 * 60 - 1, "stale"],
  [24 * 60 * 60, "expired"],
] as const)(
  "classifies age %i seconds as %s",
  async (ageSeconds, expectedClass) => {
    const now = new Date("2026-08-13T12:00:00.000Z");
    values.set(
      expectedCatalogKey,
      catalogEnvelope({
        updatedAt: new Date(now.getTime() - ageSeconds * 1_000).toISOString(),
        refreshedAt: new Date(now.getTime() - ageSeconds * 1_000).toISOString(),
      })
    );
    const result = await loadTikTokDiscoveryMarketingTemplates(
      { market: "KZ", category: "ALL", now: () => now },
      dependencies
    );
    if (expectedClass === "fresh") {
      expect(result.cacheOutcome).toBe("fresh");
      expect(dependencies.loadCredentialForGeneration).not.toHaveBeenCalled();
    } else {
      expect(dependencies.loadCredentialForGeneration).toHaveBeenCalled();
    }
  }
);

it.each([
  ["future timestamp", { refreshedAt: "2026-08-14T12:00:00.000Z" }],
  ["malformed timestamp", { refreshedAt: "not-a-date" }],
  ["schema mismatch", { schemaVersion: 2 }],
  ["API mismatch", { apiVersion: "v1.2" }],
  ["generation mismatch", { generation: "b".repeat(32) }],
  ["advertiser mismatch", { advertiserId: "202" }],
  ["market mismatch", { market: "UZ" }],
  ["category mismatch", { category: "FOOD_AND_BEVERAGE" }],
  [
    "too many items",
    {
      items: Array.from({ length: 13 }, (_, index) => ({
        ...catalogEnvelope().items[0],
        id: `tiktok:cached-${index}`,
        reference: {
          ...catalogEnvelope().items[0].reference,
          providerVideoId: `cached-${index}`,
        },
      })),
    },
  ],
  ["malformed item", { items: [{ id: "other:1" }] }],
] as const)("ignores %s", async (_name, override) => {
  values.set(
    expectedCatalogKey,
    catalogEnvelope(override as Partial<TikTokDiscoveryCacheEnvelope>)
  );
  await loadTikTokDiscoveryMarketingTemplates(
    {
      market: "KZ",
      category: "ALL",
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    },
    dependencies
  );
  expect(dependencies.loadCredentialForGeneration).toHaveBeenCalled();
});

it.each([
  ["unavailable", null, 503, "coordination_unavailable"],
  ["contended", "stale", 200, "stale_lock_contended"],
  ["contended", null, 200, "temporarily_unavailable"],
] as const)(
  "handles %s lock/cache with %s catalog",
  async (coordination, prior, status, outcome) => {
    if (coordination === "unavailable") {
      (cacheStore.readWithStatus as jest.Mock).mockResolvedValue({
        status: "unavailable",
      });
    } else {
      (cacheStore.acquireLock as jest.Mock).mockResolvedValue(coordination);
      if (prior) {
        values.set(
          expectedCatalogKey,
          catalogEnvelope({ refreshedAt: "2026-08-13T11:00:00.000Z" })
        );
      }
    }
    const result = await loadTikTokDiscoveryMarketingTemplates(
      {
        market: "KZ",
        category: "ALL",
        now: () => new Date("2026-08-13T12:00:00.000Z"),
      },
      dependencies
    );
    expect(result.transportStatus).toBe(status);
    expect(result.cacheOutcome).toBe(outcome);
    expect(dependencies.fetchTrendingHashtags).not.toHaveBeenCalled();
  }
);

it("re-reads after winning and returns a catalog published by the prior owner", async () => {
  (cacheStore.readWithStatus as jest.Mock)
    .mockResolvedValueOnce({ status: "miss" })
    .mockResolvedValueOnce({ status: "miss" })
    .mockResolvedValueOnce({
      status: "hit",
      value: catalogEnvelope({ refreshedAt: "2026-08-13T11:59:00.000Z" }),
    });
  const result = await loadTikTokDiscoveryMarketingTemplates(
    {
      market: "KZ",
      category: "ALL",
      now: () => new Date("2026-08-13T12:00:00Z"),
    },
    dependencies
  );
  expect(result.cacheOutcome).toBe("fresh");
  expect(dependencies.loadCredentialForGeneration).not.toHaveBeenCalled();
});

it.each(["catalog", "trending cooldown"] as const)(
  "releases its exact owner token when the second %s read is unavailable",
  async unavailableRead => {
    let readCount = 0;
    (cacheStore.readWithStatus as jest.Mock).mockImplementation(async () => {
      readCount += 1;
      if (
        (unavailableRead === "catalog" && readCount === 3) ||
        (unavailableRead === "trending cooldown" && readCount === 4)
      ) {
        return { status: "unavailable" };
      }
      return { status: "miss" };
    });

    const result = await loadTikTokDiscoveryMarketingTemplates(
      {
        market: "KZ",
        category: "ALL",
        now: () => new Date("2026-08-13T12:00:00.000Z"),
      },
      dependencies
    );

    const ownerToken = (cacheStore.acquireLock as jest.Mock).mock.calls[0][1];
    expect(cacheStore.compareAndDelete).toHaveBeenCalledTimes(1);
    expect(cacheStore.compareAndDelete).toHaveBeenCalledWith(
      expectedCacheKeys.refreshLock,
      ownerToken
    );
    expect(dependencies.loadCredentialForGeneration).not.toHaveBeenCalled();
    expect(dependencies.fetchTrendingHashtags).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      transportStatus: 503,
      cacheOutcome: "coordination_unavailable",
    });
  }
);

it("cannot release a newer refresh owner after a second-read outage", async () => {
  let readCount = 0;
  (cacheStore.readWithStatus as jest.Mock).mockImplementation(
    async (_key: string) => {
      readCount += 1;
      if (readCount === 3) {
        values.set(expectedCacheKeys.refreshLock, "new-owner");
        return { status: "unavailable" };
      }
      return { status: "miss" };
    }
  );
  (cacheStore.compareAndDelete as jest.Mock).mockImplementation(
    async (key: string, expectedOwner: string) => {
      if (values.get(key) !== expectedOwner) return false;
      values.delete(key);
      return true;
    }
  );

  await loadTikTokDiscoveryMarketingTemplates(
    {
      market: "KZ",
      category: "ALL",
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    },
    dependencies
  );

  const oldOwner = (cacheStore.acquireLock as jest.Mock).mock.calls[0][1];
  expect(cacheStore.compareAndDelete).toHaveBeenCalledWith(
    expectedCacheKeys.refreshLock,
    oldOwner
  );
  expect(values.get(expectedCacheKeys.refreshLock)).toBe("new-owner");
  expect(cacheStore.publishIfLockOwned).not.toHaveBeenCalled();
  expect(dependencies.fetchTrendingHashtags).not.toHaveBeenCalled();
});

it.each([
  ["lost", false, 503],
  ["lost", true, 200],
  ["unavailable", false, 503],
  ["unavailable", true, 200],
] as const)(
  "fails closed when final publication=%s with stale=%s",
  async (publishResult, hasStale, transportStatus) => {
    if (hasStale) values.set(expectedCatalogKey, catalogEnvelope());
    (cacheStore.publishIfLockOwned as jest.Mock).mockResolvedValue(
      publishResult
    );
    const result = await loadTikTokDiscoveryMarketingTemplates(
      {
        market: "KZ",
        category: "ALL",
        now: () => new Date("2026-08-13T12:00:00Z"),
      },
      dependencies
    );
    expect(cacheStore.compareAndDelete).not.toHaveBeenCalled();
    expect(result.transportStatus).toBe(transportStatus);
    expect(result.cacheOutcome).toBe("coordination_unavailable");
  }
);

it("cannot overwrite a newer catalog after losing the refresh lease", async () => {
  (cacheStore.publishIfLockOwned as jest.Mock).mockImplementation(
    async ({ valueKey }) => {
      values.set(
        valueKey,
        catalogEnvelope({
          items: [],
          updatedAt: "2026-08-13T12:00:01.000Z",
          refreshedAt: "2026-08-13T12:00:01.000Z",
        })
      );
      return "lost";
    }
  );
  const result = await loadTikTokDiscoveryMarketingTemplates(
    {
      market: "KZ",
      category: "ALL",
      now: () => new Date("2026-08-13T12:00:00Z"),
    },
    dependencies
  );
  expect(result.transportStatus).toBe(503);
  expect(values.get(expectedCatalogKey)).toEqual(
    expect.objectContaining({ refreshedAt: "2026-08-13T12:00:01.000Z" })
  );
  expect(writes).toHaveLength(0);
});

it("honors a live app-wide Trending cooldown before any provider permit", async () => {
  values.set(expectedCacheKeys.trendingCooldown, {
    schemaVersion: 1,
    apiVersion: "v1.3",
    generation: GENERATION,
    endpoint: "trending_list",
    retryAt: "2026-08-13T12:00:30.000Z",
  } satisfies TikTokDiscoveryCooldownEnvelope);
  const result = await loadTikTokDiscoveryMarketingTemplates(
    {
      market: "KZ",
      category: "ALL",
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    },
    dependencies
  );
  expect(result).toMatchObject({
    providerOutcome: "rate_limited",
    retryAt: "2026-08-13T12:00:30.000Z",
    response: { status: "temporarily_unavailable", items: [] },
  });
  expect(dependencies.acquireProviderPermit).not.toHaveBeenCalled();
  expect(dependencies.fetchTrendingHashtags).not.toHaveBeenCalled();
  const otherKeys = buildTikTokDiscoveryCacheKeys({
    developerAppId: "app-1",
    generation: GENERATION,
    advertiserId: "101",
    market: "UZ",
    category: "FOOD_AND_BEVERAGE",
  });
  expect(otherKeys.trendingCooldown).toBe(expectedCacheKeys.trendingCooldown);
  const otherCoordinate = await loadTikTokDiscoveryMarketingTemplates(
    {
      market: "UZ",
      category: "FOOD_AND_BEVERAGE",
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    },
    dependencies
  );
  expect(otherCoordinate.retryAt).toBe("2026-08-13T12:00:30.000Z");
  expect(dependencies.fetchTrendingHashtags).not.toHaveBeenCalled();
});

it.each([
  ["expired", { retryAt: "2026-08-13T11:59:59.000Z" }],
  ["future beyond bound", { retryAt: "2026-08-13T13:00:01.000Z" }],
  ["malformed", { retryAt: "not-a-date" }],
  ["wrong endpoint", { endpoint: "video_list" }],
  ["wrong generation", { generation: "b".repeat(32) }],
] as const)("ignores %s Trending cooldown", async (_name, override) => {
  values.set(expectedCacheKeys.trendingCooldown, {
    schemaVersion: 1,
    apiVersion: "v1.3",
    generation: GENERATION,
    endpoint: "trending_list",
    retryAt: "2026-08-13T12:00:30.000Z",
    ...override,
  });
  await loadTikTokDiscoveryMarketingTemplates(
    {
      market: "KZ",
      category: "ALL",
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    },
    dependencies
  );
  expect(dependencies.fetchTrendingHashtags).toHaveBeenCalledTimes(1);
});

it("fails closed when the Trending cooldown read is unavailable", async () => {
  (cacheStore.readWithStatus as jest.Mock).mockImplementation(
    async (key: string) =>
      key === expectedCacheKeys.trendingCooldown
        ? { status: "unavailable" }
        : { status: "miss" }
  );
  const result = await loadTikTokDiscoveryMarketingTemplates(
    { market: "KZ", category: "ALL" },
    dependencies
  );
  expect(result).toMatchObject({
    transportStatus: 503,
    cacheOutcome: "coordination_unavailable",
  });
  expect(dependencies.fetchTrendingHashtags).not.toHaveBeenCalled();
});

it("stores the exact bounded Trending cooldown deadline and TTL", async () => {
  (dependencies.fetchTrendingHashtags as jest.Mock).mockRejectedValue(
    new TikTokBusinessApiError("rate_limited", true, "request-1", 30)
  );
  await loadTikTokDiscoveryMarketingTemplates(
    {
      market: "KZ",
      category: "ALL",
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    },
    dependencies
  );
  expect(writes).toContainEqual({
    key: expectedCacheKeys.trendingCooldown,
    value: {
      schemaVersion: 1,
      apiVersion: "v1.3",
      generation: GENERATION,
      endpoint: "trending_list",
      retryAt: "2026-08-13T12:00:30.000Z",
    },
    ttl: 30,
  });
});

it.each(["trending", "video"] as const)(
  "bases a delayed %s Retry-After deadline on the provider failure time",
  async endpoint => {
    let currentTime = new Date("2026-08-13T12:00:00.000Z");
    const providerCall = deferred<never>();
    if (endpoint === "trending") {
      (dependencies.fetchTrendingHashtags as jest.Mock).mockReturnValue(
        providerCall.promise
      );
    } else {
      (dependencies.fetchTrendingVideos as jest.Mock).mockReturnValue(
        providerCall.promise
      );
    }

    const loading = loadTikTokDiscoveryMarketingTemplates(
      { market: "KZ", category: "ALL", now: () => currentTime },
      dependencies
    );
    await waitForCall(
      (endpoint === "trending"
        ? dependencies.fetchTrendingHashtags
        : dependencies.fetchTrendingVideos) as jest.Mock
    );
    currentTime = new Date("2026-08-13T12:05:00.000Z");
    providerCall.reject(
      new TikTokBusinessApiError("rate_limited", true, "request-1", 30)
    );
    const result = await loading;

    const cooldownKey =
      endpoint === "trending"
        ? expectedCacheKeys.trendingCooldown
        : expectedCacheKeys.videoCooldown;
    expect(writes).toContainEqual({
      key: cooldownKey,
      value: expect.objectContaining({
        retryAt: "2026-08-13T12:05:30.000Z",
      }),
      ttl: 30,
    });
    expect(result.retryAt).toBe("2026-08-13T12:05:30.000Z");
  }
);

it.each([
  ["trending", 15, "2026-08-13T12:00:45.000Z"],
  ["video", 45, "2026-08-13T12:01:15.000Z"],
] as const)(
  "aligns a %s cooldown deadline and TTL after delayed credential publication",
  async (endpoint, publicationDelaySeconds, expectedRetryAt) => {
    let currentTime = new Date("2026-08-13T12:00:00.000Z");
    const credentialPublication = deferred<"published">();
    (dependencies.markCredentialFailureAndPublish as jest.Mock).mockReturnValue(
      credentialPublication.promise
    );
    const failure = new TikTokBusinessApiError(
      "rate_limited",
      true,
      "request-1",
      30
    );
    if (endpoint === "trending") {
      (dependencies.fetchTrendingHashtags as jest.Mock).mockRejectedValue(
        failure
      );
    } else {
      (dependencies.fetchTrendingVideos as jest.Mock).mockRejectedValue(
        failure
      );
    }

    const loading = loadTikTokDiscoveryMarketingTemplates(
      { market: "KZ", category: "ALL", now: () => currentTime },
      dependencies
    );
    await waitForCall(
      dependencies.markCredentialFailureAndPublish as jest.Mock
    );
    currentTime = new Date(
      currentTime.getTime() + publicationDelaySeconds * 1_000
    );
    credentialPublication.resolve("published");
    const result = await loading;

    const cooldownKey =
      endpoint === "trending"
        ? expectedCacheKeys.trendingCooldown
        : expectedCacheKeys.videoCooldown;
    expect(writes).toContainEqual({
      key: cooldownKey,
      value: expect.objectContaining({ retryAt: expectedRetryAt }),
      ttl: 30,
    });
    expect(result.retryAt).toBe(expectedRetryAt);
    expect(Date.parse(result.retryAt!)).toBeGreaterThan(currentTime.getTime());
    expect(dependencies.fetchTrendingHashtags).toHaveBeenCalledTimes(1);
    expect(dependencies.fetchTrendingVideos).toHaveBeenCalledTimes(
      endpoint === "video" ? 1 : 0
    );
    expect(dependencies.markCredentialFailureAndPublish).toHaveBeenCalledTimes(
      1
    );
  }
);

it.each(["trending", "video"] as const)(
  "does not write a %s cooldown after the credential generation changes",
  async endpoint => {
    const failure = new TikTokBusinessApiError(
      "rate_limited",
      true,
      "request-1",
      30
    );
    if (endpoint === "trending") {
      (dependencies.fetchTrendingHashtags as jest.Mock).mockRejectedValue(
        failure
      );
    } else {
      (dependencies.fetchTrendingVideos as jest.Mock).mockRejectedValue(
        failure
      );
    }
    (
      dependencies.markCredentialFailureAndPublish as jest.Mock
    ).mockResolvedValue("changed");

    const result = await loadTikTokDiscoveryMarketingTemplates(
      { market: "KZ", category: "ALL" },
      dependencies
    );

    expect(
      writes.some(write =>
        [
          expectedCacheKeys.trendingCooldown,
          expectedCacheKeys.videoCooldown,
        ].includes(write.key)
      )
    ).toBe(false);
    expect(result).toMatchObject({
      transportStatus: 200,
      response: { status: "temporarily_unavailable", items: [] },
    });
  }
);

it.each([
  ["limited", "2026-08-13T12:00:01.000Z", "permit_limited"],
  ["unavailable", null, "permit_unavailable"],
] as const)(
  "stops before Video when its provider permit is %s",
  async (permit, retryAt, providerOutcome) => {
    (dependencies.acquireProviderPermit as jest.Mock)
      .mockResolvedValueOnce({ permit: "granted", retryAt: null })
      .mockResolvedValueOnce({ permit, retryAt });
    const result = await loadTikTokDiscoveryMarketingTemplates(
      { market: "KZ", category: "ALL" },
      dependencies
    );
    expect(dependencies.fetchTrendingHashtags).toHaveBeenCalledTimes(1);
    expect(
      dependencies.markCredentialValidatedAndPublish
    ).toHaveBeenCalledTimes(1);
    expect(dependencies.fetchTrendingVideos).not.toHaveBeenCalled();
    expect(result).toMatchObject({ providerOutcome, retryAt });
  }
);

it("fails closed when the Video cooldown read is unavailable", async () => {
  (cacheStore.readWithStatus as jest.Mock).mockImplementation(
    async (key: string) =>
      key === expectedCacheKeys.videoCooldown
        ? { status: "unavailable" }
        : { status: "miss" }
  );
  const result = await loadTikTokDiscoveryMarketingTemplates(
    { market: "KZ", category: "ALL" },
    dependencies
  );
  expect(dependencies.fetchTrendingHashtags).toHaveBeenCalledTimes(1);
  expect(dependencies.fetchTrendingVideos).not.toHaveBeenCalled();
  expect(result.transportStatus).toBe(503);
});

it("honors a live Video cooldown after successful Trending validation", async () => {
  values.set(expectedCacheKeys.videoCooldown, {
    schemaVersion: 1,
    apiVersion: "v1.3",
    generation: GENERATION,
    endpoint: "video_list",
    retryAt: "2026-08-13T12:00:30.000Z",
  } satisfies TikTokDiscoveryCooldownEnvelope);
  const result = await loadTikTokDiscoveryMarketingTemplates(
    {
      market: "KZ",
      category: "ALL",
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    },
    dependencies
  );
  expect(dependencies.fetchTrendingHashtags).toHaveBeenCalledTimes(1);
  expect(dependencies.markCredentialValidatedAndPublish).toHaveBeenCalledTimes(
    1
  );
  expect(dependencies.acquireProviderPermit).toHaveBeenCalledTimes(1);
  expect(dependencies.fetchTrendingVideos).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    providerOutcome: "rate_limited",
    retryAt: "2026-08-13T12:00:30.000Z",
  });
});

it.each([
  ["limited", "2026-08-13T12:00:01.000Z", "permit_limited"],
  ["unavailable", null, "permit_unavailable"],
] as const)(
  "makes no provider call when permit is %s",
  async (permit, retryAt, outcome) => {
    (dependencies.acquireProviderPermit as jest.Mock).mockResolvedValue({
      permit,
      retryAt,
    });
    const result = await loadTikTokDiscoveryMarketingTemplates(
      {
        market: "KZ",
        category: "ALL",
        now: () => new Date("2026-08-13T12:00:00.000Z"),
      },
      dependencies
    );
    expect(result.providerOutcome).toBe(outcome);
    expect(result.retryAt).toBe(retryAt);
    expect(dependencies.fetchTrendingHashtags).not.toHaveBeenCalled();
  }
);

it("shares endpoint cooldowns globally but isolates catalog coordinates", () => {
  const common = {
    developerAppId: "app-1",
    generation: GENERATION,
    advertiserId: "101",
  };
  const kz = buildTikTokDiscoveryCacheKeys({
    ...common,
    market: "KZ",
    category: "ALL",
  });
  const uz = buildTikTokDiscoveryCacheKeys({
    ...common,
    market: "UZ",
    category: "FOOD_AND_BEVERAGE",
  });
  expect(kz.catalog).not.toBe(uz.catalog);
  expect(kz.trendingCooldown).toBe(uz.trendingCooldown);
  expect(kz.videoCooldown).toBe(uz.videoCooldown);
  expect(kz.trendingCooldown).not.toContain("app-1");
  expect(JSON.stringify(kz)).not.toMatch(/workspace|user|secret-token/);
});

it.each([false, true] as const)(
  "normalizes rate limit with stale=%s",
  async hasStale => {
    if (hasStale) values.set(expectedCatalogKey, catalogEnvelope());
    (dependencies.fetchTrendingHashtags as jest.Mock).mockRejectedValue(
      new TikTokBusinessApiError("rate_limited", true, "request-1", 30)
    );
    const result = await loadTikTokDiscoveryMarketingTemplates(
      {
        market: "KZ",
        category: "ALL",
        now: () => new Date("2026-08-13T12:00:00Z"),
      },
      dependencies
    );
    expect(writes).toContainEqual(
      expect.objectContaining({ key: expect.stringContaining("cooldown") })
    );
    expect(result.response).toMatchObject(
      hasStale
        ? { status: "ok", stale: true, warning: "provider_rate_limited" }
        : { status: "temporarily_unavailable", items: [] }
    );
  }
);

const videoFailureCases = [
  {
    name: "rate limit",
    failure: new TikTokBusinessApiError(
      "rate_limited",
      true,
      "video-request",
      30
    ),
    credential: { status: "connected", errorCode: "provider_rate_limited" },
    warning: "provider_rate_limited",
    cold: { status: "temporarily_unavailable", items: [] },
  },
  {
    name: "revoked token",
    failure: new TikTokBusinessApiError(
      "unauthorized",
      false,
      "video-request",
      null
    ),
    credential: {
      status: "reconnect_required",
      errorCode: "reconnect_required",
    },
    warning: "provider_unavailable",
    cold: { status: "temporarily_unavailable", items: [] },
  },
  {
    name: "permission denied",
    failure: new TikTokBusinessApiError(
      "forbidden",
      false,
      "video-request",
      null
    ),
    credential: { status: "connected", errorCode: "approval_required" },
    warning: "provider_unavailable",
    cold: { status: "unavailable", items: [] },
  },
  {
    name: "retryable provider failure",
    failure: new TikTokBusinessApiError(
      "provider",
      true,
      "video-request",
      null
    ),
    credential: { status: "connected", errorCode: "provider_unavailable" },
    warning: "provider_unavailable",
    cold: { status: "error", items: [], retryable: true },
  },
  {
    name: "protocol failure",
    failure: new TikTokBusinessApiError(
      "provider",
      false,
      "video-request",
      null
    ),
    credential: { status: "connected", errorCode: "provider_protocol_error" },
    warning: "provider_unavailable",
    cold: { status: "error", items: [], retryable: false },
  },
] as const;

it.each(
  videoFailureCases.flatMap(entry =>
    ([false, true] as const).map(hasStale => ({ ...entry, hasStale }))
  )
)(
  "normalizes Video $name with stale=$hasStale",
  async ({ failure, credential, warning, cold, hasStale }) => {
    if (hasStale) {
      values.set(
        expectedCatalogKey,
        catalogEnvelope({ refreshedAt: "2026-08-13T11:00:00.000Z" })
      );
    }
    (dependencies.fetchTrendingVideos as jest.Mock).mockRejectedValue(failure);
    const result = await loadTikTokDiscoveryMarketingTemplates(
      {
        market: "KZ",
        category: "ALL",
        now: () => new Date("2026-08-13T12:00:00.000Z"),
      },
      dependencies
    );
    expect(dependencies.fetchTrendingHashtags).toHaveBeenCalledTimes(1);
    expect(dependencies.fetchTrendingVideos).toHaveBeenCalledTimes(1);
    expect(
      dependencies.markCredentialValidatedAndPublish
    ).toHaveBeenCalledTimes(1);
    expect(dependencies.markCredentialFailureAndPublish).toHaveBeenCalledWith({
      generation: GENERATION,
      ...credential,
    });
    expect(result.providerOutcome).toBe(failure.code);
    expect(result.response).toMatchObject(
      hasStale ? { status: "ok", stale: true, warning } : cold
    );
    if (failure.code === "rate_limited") {
      expect(writes).toContainEqual({
        key: expectedCacheKeys.videoCooldown,
        value: {
          schemaVersion: 1,
          apiVersion: "v1.3",
          generation: GENERATION,
          endpoint: "video_list",
          retryAt: "2026-08-13T12:00:30.000Z",
        },
        ttl: 30,
      });
    } else {
      expect(
        writes.some(write => write.key === expectedCacheKeys.videoCooldown)
      ).toBe(false);
    }
  }
);

it("caches an empty result without Video or oEmbed when no hashtag is market-eligible", async () => {
  (dependencies.fetchTrendingHashtags as jest.Mock).mockResolvedValue({
    requestId: "request-1",
    hashtags: [{ id: "us-only", name: "us", rank: 1, topCountryList: ["US"] }],
  });
  const result = await loadTikTokDiscoveryMarketingTemplates(
    {
      market: "KZ",
      category: "ALL",
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    },
    dependencies
  );
  expect(result.response).toMatchObject({ status: "ok", items: [] });
  expect(dependencies.fetchTrendingVideos).not.toHaveBeenCalled();
  expect(dependencies.fetchOEmbed).not.toHaveBeenCalled();
  expect(writes).toContainEqual(expect.objectContaining({ ttl: 86_400 }));
});

it("deduplicates by provider video ID before applying the global 12-item cap", async () => {
  (dependencies.fetchTrendingHashtags as jest.Mock).mockResolvedValue({
    requestId: "trending-request",
    hashtags: [
      { id: "rank-2", name: "two", rank: 2, topCountryList: ["KZ"] },
      { id: "rank-4", name: "four", rank: 4, topCountryList: ["KZ"] },
    ],
  });
  (dependencies.fetchTrendingVideos as jest.Mock).mockResolvedValue({
    requestId: "video-request",
    groups: [
      {
        hashtagId: "rank-2",
        videos: Array.from({ length: 13 }, (_, index) => ({
          videoId: `video-${index}`,
          shareUrl: `https://www.tiktok.com/@creator/video/${index}`,
          rank: index + 1,
        })),
      },
      {
        hashtagId: "rank-4",
        videos: [
          {
            videoId: "video-0",
            shareUrl: "https://www.tiktok.com/@other/video/0",
            rank: 1,
          },
        ],
      },
    ],
  });
  const result = await loadTikTokDiscoveryMarketingTemplates(
    { market: "KZ", category: "ALL" },
    dependencies
  );
  expect(result.response.status).toBe("ok");
  if (result.response.status !== "ok") throw new Error("expected ok catalog");
  expect(result.response.items).toHaveLength(12);
  expect(
    result.response.items.filter(
      item => item.reference.providerVideoId === "video-0"
    )
  ).toHaveLength(1);
  expect(result.response.items[0].reference).toMatchObject({
    providerVideoId: "video-0",
    hashtag: "two",
    hashtagRank: 2,
  });
});

it("bounds concurrent oEmbed enrichment at four requests", async () => {
  let active = 0;
  let maximumActive = 0;
  (dependencies.fetchTrendingVideos as jest.Mock).mockResolvedValue({
    requestId: "video-request",
    groups: [
      {
        hashtagId: "rank-2",
        videos: Array.from({ length: 12 }, (_, index) => ({
          videoId: `video-${index}`,
          shareUrl: `https://www.tiktok.com/@creator/video/${index}`,
          rank: index + 1,
        })),
      },
      { hashtagId: "rank-4", videos: [] },
    ],
  });
  (dependencies.fetchOEmbed as jest.Mock).mockImplementation(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return {
      title: "Reference",
      authorName: "Creator",
      authorUrl: null,
      thumbnailUrl: null,
    };
  });
  await loadTikTokDiscoveryMarketingTemplates(
    { market: "KZ", category: "ALL" },
    dependencies
  );
  expect(maximumActive).toBe(4);
});

it("timestamps the catalog when final publication begins after enrichment", async () => {
  let currentTime = new Date("2026-08-13T12:00:00.000Z");
  const enrichment = deferred<TikTokOEmbedMetadata>();
  (dependencies.fetchOEmbed as jest.Mock).mockReturnValue(enrichment.promise);

  const loading = loadTikTokDiscoveryMarketingTemplates(
    { market: "KZ", category: "ALL", now: () => currentTime },
    dependencies
  );
  await waitForCall(dependencies.fetchOEmbed as jest.Mock);
  currentTime = new Date("2026-08-13T12:05:00.000Z");
  enrichment.resolve({
    title: "Reference",
    authorName: "Creator",
    authorUrl: null,
    thumbnailUrl: null,
  });
  await loading;

  expect(cacheStore.publishIfLockOwned).toHaveBeenCalledWith(
    expect.objectContaining({
      value: expect.objectContaining({
        updatedAt: "2026-08-13T12:05:00.000Z",
        refreshedAt: "2026-08-13T12:05:00.000Z",
      }),
    })
  );
});

it("drops unsafe shares, nulls unsafe optional URLs, and never serializes embeds", async () => {
  (dependencies.fetchTrendingVideos as jest.Mock).mockResolvedValue({
    requestId: "video-request",
    groups: [
      {
        hashtagId: "rank-2",
        videos: [
          {
            videoId: "safe",
            shareUrl: "https://www.tiktok.com/@creator/video/1",
            rank: 1,
          },
          {
            videoId: "unsafe",
            shareUrl: "https://evil.example/video/2",
            rank: 2,
          },
        ],
      },
      { hashtagId: "rank-4", videos: [] },
    ],
  });
  (dependencies.fetchOEmbed as jest.Mock).mockResolvedValue({
    title: "Safe reference",
    authorName: "Creator",
    authorUrl: "https://evil.example/creator",
    thumbnailUrl: "https://evil.example/thumbnail.jpg",
    html: '<iframe src="https://www.tiktok.com/player/v1/1"></iframe>',
    embedUrl: "https://www.tiktok.com/player/v1/1",
  });
  const result = await loadTikTokDiscoveryMarketingTemplates(
    { market: "KZ", category: "ALL" },
    dependencies
  );
  expect(result.response.status).toBe("ok");
  if (result.response.status !== "ok") throw new Error("expected ok catalog");
  expect(result.response.items).toHaveLength(1);
  expect(result.response.items[0].reference).toMatchObject({
    providerVideoId: "safe",
    creatorUrl: null,
    thumbnailUrl: null,
  });
  expect(JSON.stringify(result.response)).not.toMatch(/html|embedUrl|iframe/i);
});

it.each([
  new Error("oEmbed unavailable"),
  new BoundedJsonResponseError("provider_response_timeout", 8_000),
])("keeps a valid Discovery reference when oEmbed fails", async failure => {
  (dependencies.fetchOEmbed as jest.Mock).mockRejectedValue(failure);
  const result = await loadTikTokDiscoveryMarketingTemplates(
    {
      market: "KZ",
      category: "ALL",
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    },
    dependencies
  );
  expect(result.response).toMatchObject({
    status: "ok",
    items: [
      {
        id: "tiktok:video-1",
        title: "#two",
        reference: { shareUrl: "https://www.tiktok.com/@creator/video/1" },
      },
    ],
  });
});

it.each([
  [new TikTokBusinessApiError("provider", true, "r1", null), 200, "error"],
  [
    new TikTokBusinessApiError("forbidden", false, "r1", null),
    200,
    "unavailable",
  ],
  [
    new TikTokBusinessApiError("unauthorized", false, "r1", null),
    200,
    "temporarily_unavailable",
  ],
] as const)(
  "normalizes provider failure %#",
  async (failure, transport, product) => {
    (dependencies.fetchTrendingHashtags as jest.Mock).mockRejectedValue(
      failure
    );
    const result = await loadTikTokDiscoveryMarketingTemplates(
      {
        market: "KZ",
        category: "ALL",
        now: () => new Date("2026-08-13T12:00:00.000Z"),
      },
      dependencies
    );
    expect(result.transportStatus).toBe(transport);
    expect(result.response.status).toBe(product);
  }
);

it.each([
  {
    name: "revoked token",
    failure: new TikTokBusinessApiError(
      "unauthorized",
      false,
      "provider-request",
      null
    ),
    credentialStatus: "reconnect_required",
    errorCode: "reconnect_required",
    warning: "provider_unavailable",
  },
  {
    name: "permission denied",
    failure: new TikTokBusinessApiError(
      "forbidden",
      false,
      "provider-request",
      null
    ),
    credentialStatus: "connected",
    errorCode: "approval_required",
    warning: "provider_unavailable",
  },
  {
    name: "rate limited",
    failure: new TikTokBusinessApiError(
      "rate_limited",
      true,
      "provider-request",
      30
    ),
    credentialStatus: "connected",
    errorCode: "provider_rate_limited",
    warning: "provider_rate_limited",
  },
  {
    name: "network or 5xx",
    failure: new TikTokBusinessApiError(
      "provider",
      true,
      "provider-request",
      null
    ),
    credentialStatus: "connected",
    errorCode: "provider_unavailable",
    warning: "provider_unavailable",
  },
  {
    name: "malformed provider response",
    failure: new TikTokBusinessApiError(
      "provider",
      false,
      "provider-request",
      null
    ),
    credentialStatus: "connected",
    errorCode: "provider_protocol_error",
    warning: "provider_unavailable",
  },
] as const)(
  "serves only validated stale data and persists safe state for $name",
  async ({ failure, credentialStatus, errorCode, warning }) => {
    values.set(
      expectedCatalogKey,
      catalogEnvelope({ refreshedAt: "2026-08-13T11:00:00.000Z" })
    );
    (dependencies.fetchTrendingHashtags as jest.Mock).mockRejectedValue(
      failure
    );
    const result = await loadTikTokDiscoveryMarketingTemplates(
      {
        market: "KZ",
        category: "ALL",
        now: () => new Date("2026-08-13T12:00:00.000Z"),
      },
      dependencies
    );
    expect(result.response).toMatchObject({
      status: "ok",
      stale: true,
      warning,
    });
    expect(dependencies.markCredentialFailureAndPublish).toHaveBeenCalledWith({
      generation: GENERATION,
      status: credentialStatus,
      errorCode,
    });
    const persisted = JSON.stringify(
      (dependencies.markCredentialFailureAndPublish as jest.Mock).mock
        .calls[0][0]
    );
    expect(persisted).not.toContain("provider-request");
  }
);

it("stops safely when credential publication reports a changed generation", async () => {
  (dependencies.fetchTrendingHashtags as jest.Mock).mockRejectedValue(
    new TikTokBusinessApiError("unauthorized", false, "provider-request", null)
  );
  (dependencies.markCredentialFailureAndPublish as jest.Mock).mockResolvedValue(
    "changed"
  );
  const result = await loadTikTokDiscoveryMarketingTemplates(
    { market: "KZ", category: "ALL" },
    dependencies
  );
  expect(dependencies.markCredentialFailureAndPublish).toHaveBeenCalledWith(
    expect.objectContaining({ generation: GENERATION })
  );
  expect(result.response).toMatchObject({
    status: "temporarily_unavailable",
    items: [],
  });
});

it.each(["published", "changed", "coordination_unavailable"] as const)(
  "maps failure publication result %s",
  async publication => {
    (dependencies.fetchTrendingHashtags as jest.Mock).mockRejectedValue(
      new TikTokBusinessApiError("unauthorized", false, "request-1", null)
    );
    (
      dependencies.markCredentialFailureAndPublish as jest.Mock
    ).mockResolvedValue(publication);
    const result = await loadTikTokDiscoveryMarketingTemplates(
      { market: "KZ", category: "ALL" },
      dependencies
    );
    expect(result.transportStatus).toBe(
      publication === "coordination_unavailable" ? 503 : 200
    );
    expect(result.response.status).toBe("temporarily_unavailable");
  }
);

it.each(["published", "changed", "coordination_unavailable"] as const)(
  "maps Trending validation publication result %s",
  async publication => {
    (dependencies.fetchTrendingVideos as jest.Mock).mockRejectedValue(
      new TikTokBusinessApiError("provider", true, "video-request", null)
    );
    (
      dependencies.markCredentialValidatedAndPublish as jest.Mock
    ).mockResolvedValue(publication);
    const result = await loadTikTokDiscoveryMarketingTemplates(
      { market: "KZ", category: "ALL" },
      dependencies
    );
    expect(dependencies.fetchTrendingVideos).toHaveBeenCalledTimes(
      publication === "published" ? 1 : 0
    );
    expect(result.transportStatus).toBe(
      publication === "coordination_unavailable" ? 503 : 200
    );
  }
);

it("validates Trending even when the subsequent Video call fails", async () => {
  (dependencies.fetchTrendingVideos as jest.Mock).mockRejectedValue(
    new TikTokBusinessApiError("provider", true, "video-request", null)
  );
  await loadTikTokDiscoveryMarketingTemplates(
    { market: "KZ", category: "ALL" },
    dependencies
  );
  expect(dependencies.markCredentialValidatedAndPublish).toHaveBeenCalledWith(
    expect.objectContaining({ generation: GENERATION })
  );
});

it("publishes validation for both successful authenticated Discovery calls", async () => {
  await loadTikTokDiscoveryMarketingTemplates(
    { market: "KZ", category: "ALL" },
    dependencies
  );
  expect(dependencies.markCredentialValidatedAndPublish).toHaveBeenCalledTimes(
    2
  );
});

it("fails closed if a provider cooldown cannot be stored", async () => {
  (dependencies.fetchTrendingHashtags as jest.Mock).mockRejectedValue(
    new TikTokBusinessApiError("rate_limited", true, "request-1", 30)
  );
  (cacheStore.writeWithStatus as jest.Mock).mockResolvedValue("unavailable");
  const result = await loadTikTokDiscoveryMarketingTemplates(
    { market: "KZ", category: "ALL" },
    dependencies
  );
  expect(result).toMatchObject({
    transportStatus: 503,
    cacheOutcome: "coordination_unavailable",
  });
});

it("uses only safe normalized fields from oEmbed metadata", async () => {
  (dependencies.fetchOEmbed as jest.Mock).mockResolvedValue({
    title: "x".repeat(501),
    authorName: "y".repeat(129),
    authorUrl: "https://www.tiktok.com/@creator",
    thumbnailUrl: "https://p16.muscdn.com/object/preview",
  } satisfies TikTokOEmbedMetadata);
  const result = await loadTikTokDiscoveryMarketingTemplates(
    { market: "KZ", category: "ALL" },
    dependencies
  );
  expect(result.response).toMatchObject({
    status: "ok",
    items: [
      {
        title: "#two",
        reference: { creatorName: null },
      },
    ],
  });
});
