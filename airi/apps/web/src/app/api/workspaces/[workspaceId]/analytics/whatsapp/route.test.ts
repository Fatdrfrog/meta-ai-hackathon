const mockAccess = jest.fn(),
  mockQuery = jest.fn();
jest.mock("@/lib/supabase/workspace-api-access", () => ({
  requireWorkspaceApiAccess: (...args: unknown[]) => mockAccess(...args),
}));
jest.mock("@/lib/analytics/whatsapp-analytics-service", () => ({
  queryWhatsAppAnalytics: (...args: unknown[]) => mockQuery(...args),
}));
import { GET } from "./route";
const context = { params: Promise.resolve({ workspaceId: "w" }) };
beforeEach(() => {
  jest.clearAllMocks();
  mockAccess.mockResolvedValue({ ok: true });
  mockQuery.mockResolvedValue({ delivery: { accepted: 2 } });
});
test("authorization denial never executes analytics", async () => {
  mockAccess.mockResolvedValue({
    ok: false,
    response: new Response(null, { status: 403 }),
  });
  expect(
    (await GET(new Request("https://local.test/api?days=30"), context)).status
  ).toBe(403);
  expect(mockQuery).not.toHaveBeenCalled();
});
test.each(["0", "1", "14", "91", "1.2", "garbage"])(
  "rejects invalid window %s",
  async days => {
    expect(
      (await GET(new Request(`https://local.test/api?days=${days}`), context))
        .status
    ).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  }
);
test("forwards workspace source scope and refresh through existing auth boundary", async () => {
  const response = await GET(
    new Request("https://local.test/api?days=7&sourceId=s&refresh=1"),
    context
  );
  expect(response.status).toBe(200);
  expect(mockQuery).toHaveBeenCalledWith({
    workspaceId: "w",
    days: 7,
    sourceId: "s",
    refresh: true,
    timeZone: "UTC",
    signal: expect.any(AbortSignal),
  });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});
test("forwards the viewer time zone for local delivery days and rejects unknown zones", async () => {
  await GET(
    new Request("https://local.test/api?days=90&timeZone=Asia/Almaty"),
    context
  );
  expect(mockQuery).toHaveBeenCalledWith(
    expect.objectContaining({ days: 90, timeZone: "Asia/Almaty" })
  );
  mockQuery.mockClear();
  const response = await GET(
    new Request("https://local.test/api?days=30&timeZone=Mars/Olympus"),
    context
  );
  expect(response.status).toBe(400);
  expect(mockQuery).not.toHaveBeenCalled();
});
test.each([
  ["asia/almaty", "Asia/Almaty"],
  ["utc", "UTC"],
  ["US/Eastern", "America/New_York"],
])(
  "answers %s under its canonical zone name %s",
  async (requested, canonical) => {
    await GET(
      new Request(
        `https://local.test/api?days=30&timeZone=${encodeURIComponent(requested)}`
      ),
      context
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({ timeZone: canonical })
    );
  }
);
test.each(["+05:30", "-0300", "+05", "SystemV/AST4"])(
  "rejects the offset or unlisted zone %s",
  async zone => {
    const response = await GET(
      new Request(
        `https://local.test/api?days=30&timeZone=${encodeURIComponent(zone)}`
      ),
      context
    );
    expect(response.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  }
);
test("provider or database failure is not an empty dashboard", async () => {
  mockQuery.mockRejectedValue(new Error("database private connection details"));
  const response = await GET(new Request("https://local.test/api"), context);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private");
});
