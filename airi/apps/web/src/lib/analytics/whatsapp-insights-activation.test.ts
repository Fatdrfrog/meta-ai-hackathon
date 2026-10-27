const mockGetJson = jest.fn();
const mockPostJson = jest.fn();
const mockMaybeSingle = jest.fn();
const mockListLimit = jest.fn();
const mockMarkEnabled = jest.fn();
const mockMarkUnsupported = jest.fn();
const mockIsUnsupported = jest.fn();
const mockProtectRateLimit = jest.fn();
const mockAcquire = jest.fn();
const mockRelease = jest.fn();
// Equality filters of the latest sources query, in call order.
const mockFilters: Array<[string, unknown]> = [];
jest.mock("@icecore/shared/lib/meta/api", () => ({
  getWhatsAppGraphClient: () => ({
    getJson: (...args: unknown[]) => mockGetJson(...args),
    postJson: (...args: unknown[]) => mockPostJson(...args),
  }),
}));
jest.mock("@/lib/supabase/admin", () => {
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn(function (this: unknown, column: string, value: unknown) {
      mockFilters.push([column, value]);
      return this;
    }),
    order: jest.fn().mockReturnThis(),
    gt: jest.fn().mockReturnThis(),
    maybeSingle: () => mockMaybeSingle(Object.fromEntries(mockFilters)),
    limit: (...args: unknown[]) => {
      const result = mockListLimit(...args);
      return Object.assign(Promise.resolve(result), query);
    },
  };
  return {
    supabaseAdmin: {
      from: jest.fn(() => {
        mockFilters.length = 0;
        return query;
      }),
    },
  };
});
jest.mock("@/lib/whatsapp/credentials", () => ({
  normalizeWhatsAppCredentials: (value: unknown) => value,
}));
jest.mock("@/lib/whatsapp/meta-read-policy", () => ({
  acquireWhatsAppMetaReadLock: (...args: unknown[]) => mockAcquire(...args),
  getCachedWhatsAppMetaReadCooldownUntil: jest.fn(async () => null),
  releaseWhatsAppMetaReadPermit: (...args: unknown[]) => mockRelease(...args),
}));
jest.mock("./whatsapp-provider-analytics", () => ({
  markWhatsAppTemplateInsightsEnabled: (...args: unknown[]) =>
    mockMarkEnabled(...args),
  markWhatsAppTemplateInsightsUnsupported: (...args: unknown[]) =>
    mockMarkUnsupported(...args),
  isWhatsAppTemplateInsightsUnsupported: (...args: unknown[]) =>
    mockIsUnsupported(...args),
  protectRateLimit: (...args: unknown[]) => mockProtectRateLimit(...args),
  statusForError: (error: { code?: number }) =>
    error.code === 190
      ? "permission_required"
      : error.code === 100
        ? "unsupported"
        : "unavailable",
}));
import {
  enableWhatsAppTemplateInsights,
  listWhatsAppInsightsSources,
} from "./whatsapp-insights-activation";

const source = {
  id: "s1",
  name: "Main",
  workspace_id: "w",
  credentials: { wabaId: "waba-1", accessToken: "private-token" },
};
// Like the database: the stored row is returned only when every applied
// equality filter matches it.
const matchesFilters = (filters: Record<string, unknown>) =>
  Object.entries({
    id: source.id,
    workspace_id: source.workspace_id,
    type: "whatsapp",
  }).every(
    ([column, value]) => !(column in filters) || filters[column] === value
  );
beforeEach(() => {
  jest.clearAllMocks();
  mockMaybeSingle.mockImplementation(
    async (filters: Record<string, unknown>) => ({
      data: matchesFilters(filters) ? source : null,
      error: null,
    })
  );
  mockAcquire.mockResolvedValue({ outcome: "acquired" });
  mockProtectRateLimit.mockResolvedValue(false);
  mockIsUnsupported.mockResolvedValue(false);
});

test("a refused account type is remembered and no longer listed as a candidate", async () => {
  mockGetJson.mockResolvedValueOnce({ is_enabled_for_insights: false });
  mockPostJson.mockRejectedValueOnce({ code: 100 });
  const refused = await enableWhatsAppTemplateInsights({
    workspaceId: "w",
    sourceId: "s1",
  });
  expect(refused.outcome).toBe("unsupported");
  expect(mockMarkUnsupported).toHaveBeenCalledWith("waba-1");

  mockIsUnsupported.mockResolvedValueOnce(true);
  mockGetJson.mockResolvedValueOnce({ is_enabled_for_insights: false });
  const dryRun = await enableWhatsAppTemplateInsights({
    workspaceId: "w",
    sourceId: "s1",
    dryRun: true,
  });
  expect(dryRun.outcome).toBe("unsupported");
  expect(mockPostJson).toHaveBeenCalledTimes(1);
});

test("enables insights with Meta's documented WABA update and marks the cache", async () => {
  mockGetJson.mockResolvedValueOnce({ is_enabled_for_insights: false });
  mockPostJson.mockResolvedValueOnce({ id: "waba-1" });
  const result = await enableWhatsAppTemplateInsights({
    workspaceId: "w",
    sourceId: "s1",
  });
  expect(result).toEqual({
    outcome: "enabled",
    sourceId: "s1",
    accountKey: "waba-1",
  });
  expect(mockPostJson).toHaveBeenCalledWith(
    "waba-1",
    expect.objectContaining({
      token: "private-token",
      query: { is_enabled_for_insights: "true" },
    })
  );
  expect(mockMarkEnabled).toHaveBeenCalledWith("waba-1");
  expect(mockRelease).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain("private-token");
});

test("is idempotent: an enabled account is never posted to", async () => {
  mockGetJson.mockResolvedValueOnce({ is_enabled_for_insights: true });
  const result = await enableWhatsAppTemplateInsights({
    workspaceId: "w",
    sourceId: "s1",
  });
  expect(result.outcome).toBe("already_enabled");
  expect(mockPostJson).not.toHaveBeenCalled();
});

test("a dry run reads the flag but never enables", async () => {
  mockGetJson.mockResolvedValueOnce({ is_enabled_for_insights: false });
  const result = await enableWhatsAppTemplateInsights({
    workspaceId: "w",
    sourceId: "s1",
    dryRun: true,
  });
  expect(result.outcome).toBe("would_enable");
  expect(mockPostJson).not.toHaveBeenCalled();
  expect(mockMarkEnabled).not.toHaveBeenCalled();
});

test.each([
  [{ code: 190 }, "permission_required"],
  [{ code: 100 }, "unsupported"],
  [{ code: 1 }, "unavailable"],
])("maps a Meta failure %o to %s", async (error, outcome) => {
  mockGetJson.mockResolvedValueOnce({ is_enabled_for_insights: false });
  mockPostJson.mockRejectedValueOnce(error);
  const result = await enableWhatsAppTemplateInsights({
    workspaceId: "w",
    sourceId: "s1",
  });
  expect(result.outcome).toBe(outcome);
  expect(mockMarkEnabled).not.toHaveBeenCalled();
  expect(mockRelease).toHaveBeenCalledTimes(1);
});

test("a rate limit sets the shared cooldown", async () => {
  mockGetJson.mockRejectedValueOnce({ status: 429 });
  mockProtectRateLimit.mockResolvedValueOnce(true);
  const result = await enableWhatsAppTemplateInsights({
    workspaceId: "w",
    sourceId: "s1",
  });
  expect(result.outcome).toBe("rate_limited");
  expect(mockProtectRateLimit).toHaveBeenCalledWith(
    "waba-1",
    source.credentials,
    { status: 429 }
  );
});

test.each([
  [
    { outcome: "cooldown", cooldownUntil: "2026-10-05T11:00:00Z" },
    "rate_limited",
  ],
  [{ outcome: "in_progress", cooldownUntil: null }, "busy"],
  [{ outcome: "coordination_unavailable", cooldownUntil: null }, "unavailable"],
])("respects the WABA read lock %o", async (permit, outcome) => {
  mockAcquire.mockResolvedValueOnce(permit);
  const result = await enableWhatsAppTemplateInsights({
    workspaceId: "w",
    sourceId: "s1",
  });
  expect(result.outcome).toBe(outcome);
  expect(mockGetJson).not.toHaveBeenCalled();
});

test("the source is read by id within the caller's workspace and type", async () => {
  mockGetJson.mockResolvedValueOnce({ is_enabled_for_insights: true });
  await enableWhatsAppTemplateInsights({ workspaceId: "w", sourceId: "s1" });
  expect(mockFilters).toEqual(
    expect.arrayContaining([
      ["id", "s1"],
      ["workspace_id", "w"],
      ["type", "whatsapp"],
    ])
  );
});

test("sources outside the workspace or without credentials are not touched", async () => {
  // Another workspace's owner names this workspace's source id.
  expect(
    (
      await enableWhatsAppTemplateInsights({
        workspaceId: "other-workspace",
        sourceId: "s1",
      })
    ).outcome
  ).toBe("not_found");
  expect(
    (await enableWhatsAppTemplateInsights({ workspaceId: "w", sourceId: "x" }))
      .outcome
  ).toBe("not_found");
  mockMaybeSingle.mockResolvedValueOnce({
    data: { ...source, credentials: { wabaId: "waba-1" } },
    error: null,
  });
  expect(
    (await enableWhatsAppTemplateInsights({ workspaceId: "w", sourceId: "s1" }))
      .outcome
  ).toBe("not_connected");
  expect(mockAcquire).not.toHaveBeenCalled();
  expect(mockGetJson).not.toHaveBeenCalled();
});

test("lists one source per WhatsApp Business Account, ids only", async () => {
  mockListLimit.mockReturnValueOnce({
    data: [
      source,
      { ...source, id: "s2" },
      { ...source, id: "s3", credentials: { wabaId: "waba-2" } },
    ],
    error: null,
  });
  const page = await listWhatsAppInsightsSources({ limit: 3 });
  expect(page.sources).toEqual([
    { id: "s1", workspaceId: "w", accountKey: "waba-1" },
    { id: "s3", workspaceId: "w", accountKey: "waba-2" },
  ]);
  expect(page.nextSourceId).toBe("s3");
  expect(JSON.stringify(page)).not.toContain("private-token");
  expect(mockFilters).toEqual([["type", "whatsapp"]]);
});

test("a scoped listing filters by workspace and source", async () => {
  mockListLimit.mockReturnValueOnce({ data: [source], error: null });
  await listWhatsAppInsightsSources({
    workspaceId: "w",
    sourceId: "s1",
    limit: 50,
  });
  expect(mockFilters).toEqual([
    ["type", "whatsapp"],
    ["workspace_id", "w"],
    ["id", "s1"],
  ]);
});
