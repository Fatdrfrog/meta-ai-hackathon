const mockSources = jest.fn();
const mockQuery = {
  select: jest.fn(),
  eq: jest.fn(),
  order: jest.fn(),
  limit: jest.fn(),
  gt: jest.fn(),
  abortSignal: jest.fn(),
  then: jest.fn(),
};
const mockProvider = jest.fn();
const mockAggregate = jest.fn();
const mockHealthWrite = jest.fn();
const mockHealthFind = jest.fn();
const mockCacheStore = new Map<string, unknown>();
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: (...args: unknown[]) => mockSources(...args) },
}));
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: { aggregate: (...args: unknown[]) => mockAggregate(...args) },
}));
jest.mock("@/models/whatsapp-template", () => ({
  WhatsAppTemplateAuditLog: {
    find: () => ({
      select: () => ({
        sort: () => ({ limit: () => ({ lean: async () => [] }) }),
      }),
    }),
  },
}));
jest.mock("@icecore/shared/lib/cache", () => ({
  buildCacheKey: (key: string, params: string[]) =>
    `${key}:${params.join(":")}`,
  cache: {
    get: jest.fn(async (key: string) => mockCacheStore.get(key) ?? null),
    set: jest.fn(async (key: string, value: unknown) => {
      mockCacheStore.set(key, value);
    }),
    acquireLock: jest.fn(async (key: string, value: unknown) => {
      if (mockCacheStore.has(key)) return "contended";
      mockCacheStore.set(key, value);
      return "acquired";
    }),
    compareAndDelete: jest.fn(async (key: string, value: unknown) => {
      if (mockCacheStore.get(key) !== value) return false;
      return mockCacheStore.delete(key);
    }),
  },
}));
jest.mock("./whatsapp-provider-analytics", () => ({
  readWhatsAppProviderAnalytics: (...args: unknown[]) => mockProvider(...args),
}));
jest.mock("@/lib/whatsapp/credentials", () => ({
  normalizeWhatsAppCredentials: (credentials: unknown) => credentials,
}));
jest.mock("@/models/whatsapp-analytics-health-daily", () => ({
  ensureWhatsAppAnalyticsHealthIndexes: jest.fn(),
  WhatsAppAnalyticsHealthDaily: {
    bulkWrite: (...args: unknown[]) => mockHealthWrite(...args),
    find: (...args: unknown[]) => mockHealthFind(...args),
  },
}));
import { cache } from "@icecore/shared/lib/cache";
import { deriveWhatsAppAccountHealth } from "@/lib/whatsapp/account/health";
import {
  deriveWhatsAppWebhookStatus,
  queryWhatsAppAnalytics,
  syncWhatsAppAnalyticsSources,
} from "./whatsapp-analytics-service";

const source = (id: string, wabaId = id) => ({
  id,
  workspace_id: "w",
  name: id,
  credentials: { wabaId, webhook_subscribed: true, quality_rating: "GREEN" },
});
const account = (id: string, wabaId = id) => ({
  sourceId: id,
  sourceName: id,
  accountKey: wabaId,
  status: "available",
  pricingStatus: "available",
  templateStatus: "activation_required",
  activationStatus: "required",
  scope: "waba",
  currency: "USD",
  approximateSpend: null,
  pricing: [],
  templates: [],
  templatesTruncated: false,
  fetchedAt: new Date().toISOString(),
  providerWindow: { start: "2026-09-25", end: "2026-10-02" },
});
function sources(values: unknown[]) {
  for (const key of [
    "select",
    "eq",
    "order",
    "limit",
    "gt",
    "abortSignal",
  ] as const)
    mockQuery[key].mockReturnValue(mockQuery);
  mockQuery.then.mockImplementation((resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: values, error: null }).then(resolve)
  );
  mockSources.mockReturnValue(mockQuery);
}
beforeEach(() => {
  jest.clearAllMocks();
  mockCacheStore.clear();
  mockAggregate.mockReturnValue({
    allowDiskUse: () => ({
      option: async () => [
        { sourceTotals: [{ _id: "s1", pending: 2, failed: 1 }] },
      ],
    }),
  });
  mockHealthFind.mockReturnValue({
    select: () => ({
      sort: () => ({ limit: () => ({ lean: async () => [] }) }),
    }),
  });
  mockProvider.mockImplementation(async ({ source: value }) =>
    account(value.id, value.credentials.wabaId)
  );
});

test("scheduled source pages use a keyset, cap at ten and retain observed pending history", async () => {
  sources(
    Array.from({ length: 11 }, (_, index) =>
      source(index === 0 ? "s1" : `s${index + 1}`)
    )
  );
  const result = await syncWhatsAppAnalyticsSources({
    workspaceId: "w",
    afterSourceId: "previous",
    limit: 100,
    now: new Date("2026-10-02T10:00:00Z"),
  });
  expect(mockQuery.gt).toHaveBeenCalledWith("id", "previous");
  expect(mockQuery.limit).toHaveBeenCalledWith(11);
  expect(result).toMatchObject({
    processed: 10,
    available: 10,
    activationRequired: 10,
    hasMore: true,
    nextSourceId: "s10",
  });
  expect(mockProvider).toHaveBeenCalledTimes(10);
  expect(mockHealthWrite.mock.calls[0][0][0].updateOne).toMatchObject({
    filter: { workspaceId: "w", sourceId: "s1", day: "2026-10-02" },
    update: [
      {
        $set: {
          pending7d: {
            $cond: [expect.any(Object), { $literal: 2 }, expect.any(Object)],
          },
          failed7d: {
            $cond: [expect.any(Object), { $literal: 1 }, expect.any(Object)],
          },
          templateIssues: {
            $cond: [expect.any(Object), { $literal: null }, expect.any(Object)],
          },
          webhookStatus: {
            $cond: [
              expect.any(Object),
              { $literal: "healthy" },
              expect.any(Object),
            ],
          },
        },
      },
    ],
  });
  expect(JSON.stringify(mockAggregate.mock.calls[0][0][0])).toContain('"$in"');
});

test("a provider failure stays partial and at most two source reads run together", async () => {
  sources([source("s1"), source("s2"), source("s3")]);
  let running = 0,
    peak = 0;
  mockProvider.mockImplementation(async ({ source: value }) => {
    running++;
    peak = Math.max(peak, running);
    await Promise.resolve();
    running--;
    if (value.id === "s2") throw new Error("provider unavailable");
    return account(value.id);
  });
  const result = await syncWhatsAppAnalyticsSources({ workspaceId: "w" });
  expect(result).toMatchObject({
    processed: 3,
    available: 2,
    unavailable: 1,
    hasMore: false,
  });
  expect(peak).toBeLessThanOrEqual(2);
});

test("an already cancelled scheduled sync starts no source, provider or health work", async () => {
  sources([source("s1")]);
  const owner = new AbortController();
  owner.abort();
  await expect(
    syncWhatsAppAnalyticsSources({ workspaceId: "w", signal: owner.signal })
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(mockSources).not.toHaveBeenCalled();
  expect(mockProvider).not.toHaveBeenCalled();
  expect(mockHealthWrite).not.toHaveBeenCalled();
});

test("source discovery forwards cancellation and a finite deadline into the active request", async () => {
  sources([]);
  const owner = new AbortController(),
    deadline = new AbortController();
  const timeout = jest
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(deadline.signal);
  let querySignal: AbortSignal | undefined;
  mockQuery.abortSignal.mockImplementation((signal: AbortSignal) => {
    querySignal = signal;
    return mockQuery;
  });
  mockQuery.then.mockImplementation(
    (
      resolve: (value: unknown) => unknown,
      reject: (error: unknown) => unknown
    ) => {
      const result = querySignal
        ? new Promise((_resolve, rejectRequest) =>
            querySignal!.addEventListener(
              "abort",
              () =>
                rejectRequest(
                  new DOMException("Request cancelled", "AbortError")
                ),
              { once: true }
            )
          )
        : Promise.resolve({ data: [], error: null });
      return result.then(resolve, reject);
    }
  );
  try {
    const pending = syncWhatsAppAnalyticsSources({
      workspaceId: "w",
      signal: owner.signal,
    });
    await Promise.resolve();
    expect(timeout).toHaveBeenCalledWith(25_000);
    owner.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(querySignal?.aborted).toBe(true);
    expect(mockProvider).not.toHaveBeenCalled();
    expect(mockHealthWrite).not.toHaveBeenCalled();
  } finally {
    timeout.mockRestore();
  }
});

test("the source-query deadline terminates a stalled scheduled discovery without an owner abort", async () => {
  sources([]);
  const deadline = new AbortController();
  const timeout = jest
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(deadline.signal);
  let querySignal: AbortSignal | undefined;
  mockQuery.abortSignal.mockImplementation((signal: AbortSignal) => {
    querySignal = signal;
    return mockQuery;
  });
  mockQuery.then.mockImplementation(
    (
      resolve: (value: unknown) => unknown,
      reject: (error: unknown) => unknown
    ) => {
      const result = querySignal
        ? new Promise((_resolve, rejectRequest) =>
            querySignal!.addEventListener(
              "abort",
              () =>
                rejectRequest(
                  new DOMException("Request timed out", "TimeoutError")
                ),
              { once: true }
            )
          )
        : Promise.resolve({ data: [], error: null });
      return result.then(resolve, reject);
    }
  );
  try {
    const pending = syncWhatsAppAnalyticsSources({ workspaceId: "w" });
    await Promise.resolve();
    deadline.abort();
    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    expect(timeout).toHaveBeenCalledWith(25_000);
    expect(mockHealthWrite).not.toHaveBeenCalled();
  } finally {
    timeout.mockRestore();
  }
});

test("cancellation stops further provider jobs and cannot publish a completed sync cursor", async () => {
  sources([source("s1"), source("s2"), source("s3")]);
  const owner = new AbortController();
  mockProvider.mockImplementation(async ({ source: value, signal }) => {
    expect(signal).toBe(owner.signal);
    owner.abort();
    return account(value.id);
  });
  await expect(
    syncWhatsAppAnalyticsSources({ workspaceId: "w", signal: owner.signal })
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(mockProvider).toHaveBeenCalledTimes(1);
  expect(mockAggregate).not.toHaveBeenCalled();
  expect(mockHealthWrite).not.toHaveBeenCalled();
});

test("cancellation during the bounded local aggregate stops health publication", async () => {
  sources([source("s1")]);
  const owner = new AbortController();
  mockAggregate.mockReturnValue({
    allowDiskUse: () => ({
      option: async () => {
        owner.abort();
        return [{ sourceTotals: [] }];
      },
    }),
  });
  await expect(
    syncWhatsAppAnalyticsSources({ workspaceId: "w", signal: owner.signal })
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(mockHealthWrite).not.toHaveBeenCalled();
});

test("two phone sources do not duplicate account-level spend and health remains independently scoped", async () => {
  sources([source("s1", "waba"), source("s2", "waba")]);
  const result = await queryWhatsAppAnalytics({ workspaceId: "w", days: 90 });
  expect(mockProvider).toHaveBeenCalledTimes(1);
  expect(result.pricing.providerAccounts).toHaveLength(1);
  expect(result.health).toHaveLength(2);
  expect(result.health.map(row => row.templateIssues)).toEqual([null, null]);
  const providerRequest = mockProvider.mock.calls[0][0];
  expect(
    providerRequest.end.getTime() - providerRequest.start.getTime()
  ).toBeLessThanOrEqual(90 * 86400000);
});

test("health shows and stores the provider's template issues for a WABA without insights", async () => {
  sources([source("s1")]);
  mockProvider.mockResolvedValue({
    ...account("s1"),
    templateStatus: "activation_required",
    templates: [],
    templateIssues: 2,
  });
  const result = await queryWhatsAppAnalytics({ workspaceId: "w", days: 30 });
  expect(result.health[0].templateIssues).toBe(2);
  expect(
    mockHealthWrite.mock.calls[0][0][0].updateOne.update[0].$set.templateIssues
  ).toEqual({
    $cond: [expect.any(Object), { $literal: 2 }, expect.any(Object)],
  });
});

test("a provider's unknown template issue count stays unknown", async () => {
  sources([source("s1")]);
  mockProvider.mockResolvedValue({
    ...account("s1"),
    templateStatus: "available",
    templates: [{ quality: "RED", status: "PAUSED" }],
    templateIssues: null,
  });
  const result = await queryWhatsAppAnalytics({ workspaceId: "w", days: 30 });
  expect(result.health[0].templateIssues).toBeNull();
});

test("source selection is workspace-bound and rejects an absent source before Mongo reads", async () => {
  sources([]);
  await expect(
    queryWhatsAppAnalytics({ workspaceId: "w", days: 30, sourceId: "foreign" })
  ).rejects.toThrow("not found");
  expect(mockQuery.eq).toHaveBeenCalledWith("workspace_id", "w");
  expect(mockQuery.eq).toHaveBeenCalledWith("id", "foreign");
  expect(mockAggregate).not.toHaveBeenCalled();
});

test("a capped template catalog cannot establish an account-wide issue count", async () => {
  sources([source("s1")]);
  mockProvider.mockResolvedValue({
    ...account("s1"),
    templateStatus: "available",
    templatesTruncated: true,
    templates: [{ quality: "RED", status: "PAUSED" }],
  });
  const result = await queryWhatsAppAnalytics({ workspaceId: "w", days: 30 });
  expect(result.health[0].templateIssues).toBeNull();
});

test.each<[Record<string, unknown>, string]>([
  [{ webhook_subscribed: true }, "healthy"],
  [
    { webhook_subscribed: true, webhook_missing_required_fields: [] },
    "healthy",
  ],
  [
    { webhook_subscribed: false, webhook_requires_reconnect: true },
    "action_required",
  ],
  [
    { webhook_subscribed: true, webhook_requires_reconnect: true },
    "action_required",
  ],
  [{ webhook_subscribed: true, webhook_coverage_ok: false }, "action_required"],
  [
    { webhook_subscribed: true, webhook_missing_required_fields: ["messages"] },
    "action_required",
  ],
  [{ webhook_subscribed: false }, "action_required"],
  [{ webhook_subscribed: null }, "unknown"],
  [{}, "unknown"],
])(
  "derives the webhook state from the keys the webhook cron saves (%j)",
  (credentials, expected) => {
    expect(
      deriveWhatsAppWebhookStatus(
        credentials,
        deriveWhatsAppAccountHealth(credentials).reasons
      )
    ).toBe(expected);
  }
);

test("health rows show the cron-verified webhook state instead of always unknown", async () => {
  sources([
    {
      ...source("s1"),
      credentials: { wabaId: "s1", webhook_subscribed: true },
    },
    {
      ...source("s2"),
      credentials: {
        wabaId: "s2",
        webhook_subscribed: false,
        webhook_requires_reconnect: true,
      },
    },
    { ...source("s3"), credentials: { wabaId: "s3" } },
  ]);
  const result = await queryWhatsAppAnalytics({ workspaceId: "w", days: 30 });
  expect(result.health.map(row => row.webhookStatus)).toEqual([
    "healthy",
    "action_required",
    "unknown",
  ]);
});

const localKey = "whatsapp:analytics-local:v2:w:all:30:UTC";
const cachedLocal = (ageMs: number, accepted: number) => ({
  generatedAt: new Date(Date.now() - ageMs).toISOString(),
  raw: { totals: [{ accepted }] },
});

test("refresh reuses a local aggregate younger than the 30 s floor", async () => {
  sources([source("s1")]);
  mockCacheStore.set(localKey, cachedLocal(10_000, 4));
  const result = await queryWhatsAppAnalytics({
    workspaceId: "w",
    days: 30,
    refresh: true,
  });
  expect(mockAggregate).not.toHaveBeenCalled();
  expect(result.delivery.accepted).toBe(4);
});

test("refresh recomputes an older local aggregate and later views reuse it", async () => {
  sources([source("s1")]);
  mockCacheStore.set(localKey, cachedLocal(40_000, 4));
  mockAggregate.mockReturnValue({
    allowDiskUse: () => ({
      option: async () => [{ totals: [{ accepted: 9 }] }],
    }),
  });
  const refreshed = await queryWhatsAppAnalytics({
    workspaceId: "w",
    days: 30,
    refresh: true,
  });
  expect(refreshed.delivery.accepted).toBe(9);
  const again = await queryWhatsAppAnalytics({ workspaceId: "w", days: 30 });
  expect(again.delivery.accepted).toBe(9);
  expect(mockAggregate).toHaveBeenCalledTimes(1);
  expect(mockCacheStore.has(`${localKey}:lock`)).toBe(false);
});

test("concurrent views share one running local aggregate", async () => {
  sources([source("s1")]);
  let finish: (rows: unknown[]) => void = () => undefined;
  mockAggregate.mockReturnValue({
    allowDiskUse: () => ({
      option: () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    }),
  });
  const first = queryWhatsAppAnalytics({ workspaceId: "w", days: 30 });
  const second = queryWhatsAppAnalytics({
    workspaceId: "w",
    days: 30,
    refresh: true,
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(mockAggregate).toHaveBeenCalledTimes(1);
  expect(cache.acquireLock).toHaveBeenCalledTimes(2);
  finish([{ totals: [{ accepted: 7 }] }]);
  const results = await Promise.all([first, second]);
  expect(results.map(result => result.delivery.accepted)).toEqual([7, 7]);
  expect(mockAggregate).toHaveBeenCalledTimes(1);
});

test("a failed aggregate releases its lock so the next view can retry", async () => {
  sources([source("s1")]);
  mockAggregate.mockReturnValueOnce({
    allowDiskUse: () => ({
      option: async () => {
        throw new Error("operation exceeded time limit");
      },
    }),
  });
  await expect(
    queryWhatsAppAnalytics({ workspaceId: "w", days: 30 })
  ).rejects.toThrow("time limit");
  expect(mockCacheStore.has(`${localKey}:lock`)).toBe(false);
  await queryWhatsAppAnalytics({ workspaceId: "w", days: 30 });
  expect(mockAggregate).toHaveBeenCalledTimes(2);
});

test("a cancelled view stops before the local aggregate", async () => {
  sources([source("s1")]);
  const owner = new AbortController();
  owner.abort();
  await expect(
    queryWhatsAppAnalytics({ workspaceId: "w", days: 30, signal: owner.signal })
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(mockAggregate).not.toHaveBeenCalled();
});

test("the window starts at the viewer's local midnight and buckets days in that zone", async () => {
  jest.useFakeTimers({ now: new Date("2026-10-05T03:00:00Z") });
  try {
    sources([source("s1")]);
    const result = await queryWhatsAppAnalytics({
      workspaceId: "w",
      days: 7,
      timeZone: "Asia/Almaty",
    });
    expect(result.window.start).toBe("2026-09-28T19:00:00.000Z");
    const pipeline = mockAggregate.mock.calls[0][0];
    expect(pipeline[0].$match.date.$gte).toEqual(
      new Date("2026-09-28T19:00:00.000Z")
    );
    expect(JSON.stringify(pipeline)).toContain('"timezone":"Asia/Almaty"');
    expect(
      mockCacheStore.has("whatsapp:analytics-local:v2:w:all:7:Asia/Almaty")
    ).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});
