const mockGetJson = jest.fn();
const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn();
const mockBulkWrite = jest.fn();
const mockFind = jest.fn();
jest.mock("@icecore/shared/lib/meta/api", () => ({
  getWhatsAppGraphClient: () => ({
    getJson: (...args: unknown[]) => mockGetJson(...args),
  }),
  collectMetaGraphEdge: jest.fn(async () => [
    {
      id: "1",
      name: "Offer",
      language: "en",
      category: "MARKETING",
      status: "APPROVED",
      quality_rating: "GREEN",
    },
  ]),
  MetaGraphRequestError: class extends Error {},
  getMetaGraphRateLimitMetadata: jest.fn(() => null),
}));
jest.mock("@icecore/shared/lib/cache", () => ({
  buildCacheKey: (prefix: string, args: string[]) =>
    [prefix, ...args].join(":"),
  cache: {
    get: (...args: unknown[]) => mockCacheGet(...args),
    set: (...args: unknown[]) => mockCacheSet(...args),
  },
}));
jest.mock("@/lib/whatsapp/meta-read-policy", () => ({
  META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD: "meta_diagnostics_cooldown_until",
  acquireWhatsAppMetaReadLock: jest.fn(async () => ({ outcome: "acquired" })),
  releaseWhatsAppMetaReadPermit: jest.fn(),
  getCachedWhatsAppMetaReadCooldownUntil: jest.fn(),
  buildWhatsAppMetaRateLimitCredentialPatch: jest.fn(),
  setCachedWhatsAppMetaReadCooldownUntil: jest.fn(),
}));
jest.mock("@/lib/whatsapp/credentials", () => ({
  normalizeWhatsAppCredentials: (value: unknown) => value,
}));
jest.mock("@/models/whatsapp-template-analytics-daily", () => ({
  ensureWhatsAppTemplateAnalyticsIndexes: jest.fn(),
  WhatsAppTemplateAnalyticsDaily: {
    bulkWrite: (...args: unknown[]) => mockBulkWrite(...args),
    find: (...args: unknown[]) => mockFind(...args),
  },
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: jest.fn() },
}));
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
import {
  buildTemplateObservationWrites,
  markWhatsAppTemplateInsightsEnabled,
  markWhatsAppTemplateInsightsUnsupported,
  readWhatsAppProviderAnalytics,
  readWhatsAppProviderSpend,
  statusForError,
} from "./whatsapp-provider-analytics";
import {
  collectMetaGraphEdge,
  getMetaGraphRateLimitMetadata,
  MetaGraphRequestError,
} from "@icecore/shared/lib/meta/api";
import {
  acquireWhatsAppMetaReadLock,
  buildWhatsAppMetaRateLimitCredentialPatch,
  setCachedWhatsAppMetaReadCooldownUntil,
} from "@/lib/whatsapp/meta-read-policy";

const source = {
  id: "s",
  name: "Phone",
  workspace_id: "w",
  credentials: { wabaId: "123", accessToken: "private-token" },
};
const window = { start: new Date("2026-09-30"), end: new Date("2026-10-02") };
beforeEach(() => {
  jest.clearAllMocks();
  mockCacheGet.mockReset();
  mockFind.mockReturnValue({
    select: () => ({ limit: () => ({ lean: async () => [] }) }),
  });
});
test("reports activation required without posting activation or calling template data", async () => {
  mockGetJson
    .mockResolvedValueOnce({ currency: "KZT", is_enabled_for_insights: false })
    .mockResolvedValueOnce({ pricing_analytics: { data: [] } });
  const result = await readWhatsAppProviderAnalytics({ source, ...window });
  expect(result.templateStatus).toBe("activation_required");
  expect(result.approximateSpend).toBeNull();
  expect(mockGetJson).toHaveBeenCalledTimes(2);
  expect(result.templates).toEqual([]);
  expect(mockBulkWrite).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain("private-token");
});

test("reads template status and quality without insights so template issues are known", async () => {
  (collectMetaGraphEdge as jest.Mock).mockResolvedValueOnce([
    { id: "1", name: "a", status: "APPROVED", quality_rating: "GREEN" },
    { id: "2", name: "b", status: "PAUSED", quality_rating: "YELLOW" },
    {
      id: "3",
      name: "c",
      status: "APPROVED",
      quality_rating: { score: "RED" },
    },
    { id: "4", name: "d", status: "REJECTED" },
  ]);
  mockGetJson
    .mockResolvedValueOnce({ currency: "KZT", is_enabled_for_insights: false })
    .mockResolvedValueOnce({ pricing_analytics: { data: [] } });
  const result = await readWhatsAppProviderAnalytics({ source, ...window });
  expect(collectMetaGraphEdge).toHaveBeenCalledWith(
    expect.objectContaining({ path: "123/message_templates" })
  );
  expect(result).toMatchObject({
    templateStatus: "activation_required",
    templateIssues: 3,
    templates: [],
  });
  expect(
    mockGetJson.mock.calls.some(([, options]) =>
      String(options.query.fields).includes("template_analytics")
    )
  ).toBe(false);
});

test("an unavailable catalog keeps activation required and leaves issues unknown", async () => {
  (collectMetaGraphEdge as jest.Mock).mockRejectedValueOnce(
    new Error("catalog unavailable")
  );
  mockGetJson
    .mockResolvedValueOnce({ currency: "KZT", is_enabled_for_insights: false })
    .mockResolvedValueOnce({ pricing_analytics: { data: [] } });
  const result = await readWhatsAppProviderAnalytics({ source, ...window });
  expect(result).toMatchObject({
    templateStatus: "activation_required",
    templateIssues: null,
  });
});

test("a truncated catalog cannot claim a complete issue count", async () => {
  (collectMetaGraphEdge as jest.Mock).mockResolvedValueOnce(
    Array.from({ length: 101 }, (_, index) => ({
      id: String(index + 1),
      status: "APPROVED",
    }))
  );
  mockGetJson
    .mockResolvedValueOnce({ currency: "KZT", is_enabled_for_insights: false })
    .mockResolvedValueOnce({ pricing_analytics: { data: [] } });
  const result = await readWhatsAppProviderAnalytics({ source, ...window });
  expect(result.templatesTruncated).toBe(true);
  expect(result.templateIssues).toBeNull();
});

test("a cached activation-required account is re-read once insights were enabled", async () => {
  const cachedAccount = {
    sourceId: "s",
    activationStatus: "required",
    templateStatus: "activation_required",
    fetchedAt: new Date().toISOString(),
  };
  mockCacheGet.mockImplementation(async (key: string) =>
    key.startsWith("whatsapp:analytics:v1")
      ? cachedAccount
      : key === "whatsapp:insights-enabled:v1:123"
        ? true
        : undefined
  );
  mockGetJson
    .mockResolvedValueOnce({ currency: "KZT", is_enabled_for_insights: true })
    .mockResolvedValueOnce({ pricing_analytics: { data: [] } })
    .mockResolvedValueOnce({ template_analytics: { data: [] } });
  const result = await readWhatsAppProviderAnalytics({ source, ...window });
  expect(result.activationStatus).toBe("enabled");
  expect(result.templateStatus).toBe("available");
  await markWhatsAppTemplateInsightsEnabled("123");
  expect(mockCacheSet).toHaveBeenCalledWith(
    "whatsapp:insights-enabled:v1:123",
    true,
    600
  );
});

test("spend reads only account pricing and caches it under its own key", async () => {
  mockGetJson
    .mockResolvedValueOnce({ currency: "USD", is_enabled_for_insights: false })
    .mockResolvedValueOnce({
      pricing_analytics: {
        data: [
          {
            data_points: [
              { pricing_category: "MARKETING", volume: 3, cost: 0.12 },
              { pricing_category: "UTILITY", volume: 2, cost: 0.03 },
            ],
          },
        ],
      },
    });
  const spend = await readWhatsAppProviderSpend({ source, ...window });
  expect(spend).toMatchObject({
    accountKey: "123",
    status: "available",
    pricingStatus: "available",
    currency: "USD",
  });
  expect(spend.approximateSpend).toBeCloseTo(0.15);
  expect(spend).not.toHaveProperty("templates");
  expect(collectMetaGraphEdge).not.toHaveBeenCalled();
  expect(mockGetJson).toHaveBeenCalledTimes(2);
  expect(mockCacheSet).toHaveBeenCalledWith(
    "whatsapp:spend:v1:w:123:2026-09-30:2026-10-02",
    expect.objectContaining({ approximateSpend: spend.approximateSpend }),
    300
  );
  expect(JSON.stringify(spend)).not.toContain("private-token");
});

test("spend reuses a same-window analytics read without calling Meta", async () => {
  mockCacheGet.mockImplementation(async (key: string) =>
    key === "whatsapp:analytics:v1:w:123:2026-09-30:2026-10-02"
      ? {
          sourceId: "other",
          sourceName: "Old",
          accountKey: "123",
          status: "available",
          pricingStatus: "available",
          currency: "KZT",
          approximateSpend: 420,
          pricing: [],
          templates: [{ id: "1" }],
          fetchedAt: "2026-10-02T00:00:00Z",
        }
      : undefined
  );
  const spend = await readWhatsAppProviderSpend({ source, ...window });
  expect(spend).toMatchObject({
    sourceId: "s",
    sourceName: "Phone",
    approximateSpend: 420,
  });
  expect(spend).not.toHaveProperty("templates");
  expect(mockGetJson).not.toHaveBeenCalled();
  expect(acquireWhatsAppMetaReadLock).not.toHaveBeenCalled();
});

const metaError = (status: number, error: Record<string, unknown>) =>
  Object.assign(
    new MetaGraphRequestError({
      message: String(error.message ?? "error"),
      status,
      statusText: "",
      url: "",
      details: null,
    }),
    { status, metaError: error }
  );

test("Meta's SMB business type refusal is unsupported, not a permission problem", () => {
  expect(
    statusForError(
      metaError(400, {
        code: 10,
        type: "OAuthException",
        message:
          "(#10) This operation can not be performed on SMB business type",
      })
    )
  ).toBe("unsupported");
  expect(
    statusForError(
      metaError(400, { code: 10, message: "(#10) Permission denied" })
    )
  ).toBe("permission_required");
});

test("an account Meta refused insights for is not offered activation again", async () => {
  mockCacheGet.mockImplementation(async (key: string) =>
    key === "whatsapp:insights-unsupported:v1:123" ? true : undefined
  );
  mockGetJson
    .mockResolvedValueOnce({ currency: "KZT", is_enabled_for_insights: false })
    .mockResolvedValueOnce({ pricing_analytics: { data: [] } });
  const result = await readWhatsAppProviderAnalytics({ source, ...window });
  expect(result).toMatchObject({
    activationStatus: "required",
    templateStatus: "unsupported",
    // Catalog health is still read: the one approved green template is fine.
    templateIssues: 0,
  });
  await markWhatsAppTemplateInsightsUnsupported("123");
  expect(mockCacheSet).toHaveBeenCalledWith(
    "whatsapp:insights-unsupported:v1:123",
    true,
    30 * 24 * 60 * 60
  );
});

test("spend maps an expired token to permission required and caches it briefly", async () => {
  mockGetJson.mockRejectedValueOnce(
    Object.assign(
      new MetaGraphRequestError({
        message: "expired",
        status: 401,
        statusText: "Unauthorized",
        url: "",
        details: null,
      }),
      { status: 401, metaError: { code: 190 } }
    )
  );
  const spend = await readWhatsAppProviderSpend({ source, ...window });
  expect(spend.pricingStatus).toBe("permission_required");
  expect(mockCacheSet).toHaveBeenCalledWith(
    expect.stringContaining("whatsapp:spend:v1"),
    expect.objectContaining({ pricingStatus: "permission_required" }),
    60
  );
});

test("spend reports a busy or cooling-down account as unavailable without calling Meta", async () => {
  (acquireWhatsAppMetaReadLock as jest.Mock).mockResolvedValueOnce({
    outcome: "cooldown",
  });
  const spend = await readWhatsAppProviderSpend({ source, ...window });
  expect(spend.pricingStatus).toBe("unavailable");
  expect(mockGetJson).not.toHaveBeenCalled();
  expect(mockCacheSet).not.toHaveBeenCalled();
});

test("spend without stored credentials is not connected", async () => {
  const spend = await readWhatsAppProviderSpend({
    source: { ...source, credentials: {} },
    ...window,
  });
  expect(spend.pricingStatus).toBe("not_connected");
  expect(mockGetJson).not.toHaveBeenCalled();
});
test("preserves observed read and clicks using max updates after provider reset", () => {
  const writes = buildTemplateObservationWrites(
    "w",
    "123",
    {
      template_analytics: {
        data: [
          {
            data_points: [
              {
                template_id: "1",
                start: 10,
                end: 20,
                sent: 4,
                delivered: 3,
                read: 0,
                clicked: [{ type: "unique_url_button", count: 0 }],
              },
            ],
          },
        ],
      },
    },
    "USD",
    new Date(20 * 1000)
  );
  expect(writes[0].updateOne.filter).toMatchObject({
    workspaceId: "w",
    wabaId: "123",
    templateId: "1",
  });
  expect(writes[0].updateOne.update.$max).toMatchObject({
    read: 0,
    uniqueClicked: 0,
  });
  expect(writes[0].updateOne.update.$set).not.toHaveProperty("read");
});
test("does not retain invented zero counts for omitted click types", () => {
  const [write] = buildTemplateObservationWrites(
    "w",
    "123",
    {
      template_analytics: {
        data: [
          {
            data_points: [
              {
                template_id: "1",
                start: 10,
                end: 20,
                sent: 4,
                delivered: 3,
                clicked: [{ type: "url_button", count: 2 }],
              },
            ],
          },
        ],
      },
    },
    "USD",
    new Date(20 * 1000)
  );
  expect(write.updateOne.update.$max).toEqual({
    sent: 4,
    delivered: 3,
    clicked: 2,
  });
});
test("falls back to volume-only pricing without filling withheld cost", async () => {
  mockGetJson
    .mockResolvedValueOnce({ currency: "USD", is_enabled_for_insights: false })
    .mockRejectedValueOnce(new Error("Cost unavailable"))
    .mockResolvedValueOnce({
      pricing_analytics: {
        data: [{ data_points: [{ pricing_category: "SERVICE", volume: 3 }] }],
      },
    });
  const result = await readWhatsAppProviderAnalytics({ source, ...window });
  expect(result.pricingStatus).toBe("available");
  expect(result.pricing[0].volume).toBe(3);
  expect(result.approximateSpend).toBeNull();
  expect(mockGetJson.mock.calls[2][1].query.fields).not.toContain("COST");
});
test("fetches templates only after enabled flag, persists metrics and retains catalog health", async () => {
  mockGetJson
    .mockResolvedValueOnce({ currency: "USD", is_enabled_for_insights: true })
    .mockResolvedValueOnce({ pricing_analytics: { data: [] } })
    .mockResolvedValueOnce({ template_analytics: { data: [] } });
  const result = await readWhatsAppProviderAnalytics({ source, ...window });
  expect(result.templateStatus).toBe("available");
  expect(result.templates[0]).toMatchObject({
    id: "1",
    quality: "GREEN",
    status: "APPROVED",
  });
  expect(mockGetJson.mock.calls[2][1].query.fields).toContain(
    'template_ids(["1"])'
  );
});

test("rate limits set the existing WABA cooldown and do not immediately retry cost", async () => {
  (getMetaGraphRateLimitMetadata as jest.Mock).mockReturnValueOnce({
    status: 429,
    code: 4,
  });
  (buildWhatsAppMetaRateLimitCredentialPatch as jest.Mock).mockReturnValueOnce({
    meta_diagnostics_cooldown_until: "2026-10-02T12:05:00Z",
  });
  mockGetJson
    .mockResolvedValueOnce({ currency: "USD", is_enabled_for_insights: true })
    .mockRejectedValueOnce(new Error("rate limited"));
  const result = await readWhatsAppProviderAnalytics({ source, ...window });
  expect(result.pricingStatus).toBe("unavailable");
  expect(mockGetJson).toHaveBeenCalledTimes(2);
  expect(setCachedWhatsAppMetaReadCooldownUntil).toHaveBeenCalledWith(
    "123",
    "2026-10-02T12:05:00Z"
  );
});

test("persists completed ten-template batches before a later batch fails", async () => {
  (collectMetaGraphEdge as jest.Mock).mockResolvedValueOnce(
    Array.from({ length: 11 }, (_, index) => ({
      id: String(index + 1),
      name: "template",
      category: "MARKETING",
    }))
  );
  mockGetJson
    .mockResolvedValueOnce({ currency: "USD", is_enabled_for_insights: true })
    .mockResolvedValueOnce({ pricing_analytics: { data: [] } })
    .mockResolvedValueOnce({
      template_analytics: {
        data: [
          {
            data_points: [
              {
                template_id: "1",
                start: Math.floor(Date.now() / 1000) - 100,
                end: Math.floor(Date.now() / 1000) - 50,
                sent: 3,
                delivered: 2,
                read: 1,
                clicked: [],
              },
            ],
          },
        ],
      },
    })
    .mockRejectedValueOnce(new Error("last batch unavailable"));
  const result = await readWhatsAppProviderAnalytics({ source, ...window });
  expect(result.templateStatus).toBe("unavailable");
  expect(mockBulkWrite).toHaveBeenCalledTimes(1);
  expect(mockBulkWrite.mock.calls[0][0][0].updateOne.update.$max.read).toBe(1);
  const ids = /template_ids\((.*?)\)\.metric_types/.exec(
    mockGetJson.mock.calls[2][1].query.fields
  )![1];
  expect(JSON.parse(ids)).toHaveLength(10);
});

test("authentication click capability and absent provider read are unknown", async () => {
  (collectMetaGraphEdge as jest.Mock).mockResolvedValueOnce([
    {
      id: "1",
      name: "Login",
      category: "AUTHENTICATION",
      quality_rating: { score: "GREEN" },
    },
  ]);
  mockGetJson
    .mockResolvedValueOnce({ currency: "USD", is_enabled_for_insights: true })
    .mockResolvedValueOnce({ pricing_analytics: { data: [] } })
    .mockResolvedValueOnce({ template_analytics: { data: [] } });
  const result = await readWhatsAppProviderAnalytics({ source, ...window });
  expect(result.templates[0]).toMatchObject({
    quality: "GREEN",
    read: null,
    clicked: null,
    uniqueClicked: null,
    clickRate: null,
  });
});

test("unobserved older provider resets cannot establish zero reads or relabel retained cost", () => {
  const writes = buildTemplateObservationWrites(
    "w",
    "waba",
    {
      template_analytics: {
        data: [
          {
            data_points: [
              {
                template_id: "1",
                start: Date.parse("2026-09-01") / 1000,
                end: Date.parse("2026-09-02") / 1000,
                sent: 3,
                delivered: 2,
                read: 0,
                clicked: [],
              },
            ],
          },
        ],
      },
    },
    "KZT",
    new Date("2026-10-02")
  );
  expect(writes[0].updateOne.update.$max).toEqual({ sent: 3, delivered: 2 });
  expect(writes[0].updateOne.update.$set).not.toHaveProperty("currency");
  expect(writes[0].updateOne.update).toHaveProperty(
    "$setOnInsert.currency",
    "KZT"
  );
});
