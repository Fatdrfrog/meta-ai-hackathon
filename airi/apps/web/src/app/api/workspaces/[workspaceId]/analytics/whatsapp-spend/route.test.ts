const mockAccess = jest.fn(),
  mockQuery = jest.fn(),
  mockRateLimit = jest.fn();
jest.mock("@/lib/supabase/workspace-api-access", () => ({
  requireWorkspaceApiAccess: (...args: unknown[]) => mockAccess(...args),
}));
jest.mock("@icecore/shared/lib/rate-limiter", () => ({
  createRateLimiter: () => null,
  checkRateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));
jest.mock("@/lib/analytics/whatsapp-spend", () => ({
  queryWhatsAppSpend: (...args: unknown[]) => mockQuery(...args),
}));
import { GET } from "./route";
const context = { params: Promise.resolve({ workspaceId: "w" }) };
const NOW = new Date("2026-10-05T10:00:00.000Z");
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ now: NOW });
  mockAccess.mockResolvedValue({ ok: true, userId: "u" });
  mockQuery.mockResolvedValue({ state: "available", totals: [] });
  mockRateLimit.mockResolvedValue({ success: true });
});
afterEach(() => jest.useRealTimers());
test("a member over the per-minute limit gets 429 without a Meta read", async () => {
  mockRateLimit.mockResolvedValue({ success: false });
  const response = await GET(
    new Request("https://local.test/api?days=30"),
    context
  );
  expect(response.status).toBe(429);
  expect(mockRateLimit).toHaveBeenCalledWith(null, "w:u", 20);
  expect(mockQuery).not.toHaveBeenCalled();
});
test("authorization denial never reads Meta spend", async () => {
  mockAccess.mockResolvedValue({
    ok: false,
    response: new Response(null, { status: 403 }),
  });
  expect(
    (await GET(new Request("https://local.test/api?days=30"), context)).status
  ).toBe(403);
  expect(mockAccess).toHaveBeenCalledWith("w");
  expect(mockQuery).not.toHaveBeenCalled();
});
test.each([
  "days=0",
  "days=91",
  "days=1.5",
  // Only the presets the UI offers; other counts would multiply cache keys.
  "days=1",
  "days=14",
  "days=89",
  "from=garbage&to=2026-10-02T00:00:00Z",
  "from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z",
  "from=2026-10-01T00:00:00Z",
  "to=2026-10-01",
  // Local time without a zone is ambiguous.
  "from=2026-09-01T00:00:00&to=2026-09-30T00:00:00",
  // More than 90 days between the dates.
  "from=2026-07-06&to=2026-10-05",
  "from=2026-01-01&to=2026-10-05",
  // Starts before the 365-day lookback.
  "from=2025-10-04&to=2025-11-30",
  "from=2019-01-01&to=2019-02-01",
  // Starts in the future.
  "from=2026-10-06&to=2026-10-07",
])("rejects an unbounded or invalid window %s", async query => {
  expect(
    (await GET(new Request(`https://local.test/api?${query}`), context)).status
  ).toBe(400);
  expect(mockQuery).not.toHaveBeenCalled();
});
test("defaults to the last 30 days", async () => {
  const response = await GET(new Request("https://local.test/api"), context);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const { workspaceId, start, end } = mockQuery.mock.calls[0][0];
  expect(workspaceId).toBe("w");
  expect(end).toEqual(NOW);
  expect(end.getTime() - start.getTime()).toBe(30 * 86400000);
  await expect(response.json()).resolves.toEqual({
    state: "available",
    totals: [],
  });
});
test.each([7, 30, 90])("accepts the %i-day preset", async days => {
  await GET(new Request(`https://local.test/api?days=${days}`), context);
  const { start, end } = mockQuery.mock.calls[0][0];
  expect(end.getTime() - start.getTime()).toBe(days * 86400000);
});
test("snaps an explicit report window to whole UTC dates", async () => {
  await GET(
    new Request(
      "https://local.test/api?from=2026-09-21T18:30:00.000Z&to=2026-09-30T05:00:00.000Z"
    ),
    context
  );
  expect(mockQuery).toHaveBeenCalledWith({
    workspaceId: "w",
    start: new Date("2026-09-21T00:00:00.000Z"),
    end: new Date("2026-09-30T23:59:59.999Z"),
  });
});
test("reads a period ending today, or later, only up to now", async () => {
  for (const query of [
    "from=2026-07-07&to=2026-10-05",
    "from=2026-07-07&to=2026-10-08",
  ]) {
    mockQuery.mockClear();
    await GET(new Request(`https://local.test/api?${query}`), context);
    expect(mockQuery).toHaveBeenCalledWith({
      workspaceId: "w",
      start: new Date("2026-07-07T00:00:00.000Z"),
      end: NOW,
    });
  }
});
test("accepts the oldest start within the lookback", async () => {
  const response = await GET(
    new Request("https://local.test/api?from=2025-10-05&to=2025-12-01"),
    context
  );
  expect(response.status).toBe(200);
});
test("a provider or database failure is not reported as zero spend", async () => {
  mockQuery.mockRejectedValue(new Error("private connection details"));
  const response = await GET(new Request("https://local.test/api"), context);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private");
});
