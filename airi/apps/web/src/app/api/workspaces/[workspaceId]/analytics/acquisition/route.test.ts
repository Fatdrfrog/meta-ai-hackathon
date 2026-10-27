const mockAccess = jest.fn(),
  mockReport = jest.fn(),
  mockConnect = jest.fn();
jest.mock("@/lib/supabase/workspace-api-access", () => ({
  requireWorkspaceApiAccess: (...args: unknown[]) => mockAccess(...args),
}));
jest.mock("@/lib/analytics/acquisition-report", () => ({
  getAcquisitionReport: (...args: unknown[]) => mockReport(...args),
}));
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: () => mockConnect(),
}));
import { GET } from "./route";
const context = { params: Promise.resolve({ workspaceId: "workspace" }) };
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date("2026-10-02T10:30:00Z"));
  jest.clearAllMocks();
  mockAccess.mockResolvedValue({ ok: true });
  mockReport.mockResolvedValue({ coverage: { status: "backfilling" } });
});
afterEach(() => {
  jest.useRealTimers();
});
test("unauthorized workspace cannot read any acquisition facts", async () => {
  mockAccess.mockResolvedValue({
    ok: false,
    response: new Response(null, { status: 403 }),
  });
  expect(
    (await GET(new Request("https://local.test/api"), context)).status
  ).toBe(403);
  expect(mockReport).not.toHaveBeenCalled();
});
test.each([
  "days=366",
  "observationDays=14",
  "sourceId=other",
  "timeZone=not-a-zone",
  // Bare offsets are not IANA names.
  "timeZone=%2B05%3A30",
  "timeZone=-03%3A00",
])("invalid scope is rejected: %s", async query => {
  const response = await GET(
    new Request(`https://local.test/api?${query}`),
    context
  );
  expect(response.status).toBe(400);
  expect(mockReport).not.toHaveBeenCalled();
});
test("a zone in any letter case reaches the report under its canonical name", async () => {
  const response = await GET(
    new Request("https://local.test/api?days=7&timeZone=asia%2Falmaty"),
    context
  );
  expect(response.status).toBe(200);
  expect(mockReport).toHaveBeenCalledWith(
    expect.objectContaining({ timeZone: "Asia/Almaty" })
  );
});
test("forwards seven inclusive local calendar dates and exact source with private cache", async () => {
  const source = "00000000-0000-4000-8000-000000000002";
  const response = await GET(
    new Request(
      `https://local.test/api?days=7&observationDays=30&sourceId=${source}&timeZone=Asia/Qyzylorda`
    ),
    context
  );
  expect(response.status).toBe(200);
  expect(mockReport).toHaveBeenCalledWith({
    workspaceId: "workspace",
    sourceId: source,
    observationDays: 30,
    start: new Date("2026-09-25T19:00:00Z"),
    end: new Date("2026-10-02T19:00:00Z"),
    timeZone: "Asia/Qyzylorda",
  });
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
});
test("explicit calendar dates override the preset and preserve both DST boundaries", async () => {
  const response = await GET(
    new Request(
      "https://local.test/api?days=90&observationDays=7&from=2026-03-07&to=2026-03-09&timeZone=America/New_York"
    ),
    context
  );
  expect(response.status).toBe(200);
  expect(mockReport).toHaveBeenCalledWith({
    workspaceId: "workspace",
    sourceId: null,
    observationDays: 7,
    start: new Date("2026-03-07T05:00:00Z"),
    end: new Date("2026-03-10T04:00:00Z"),
    timeZone: "America/New_York",
  });
});
test.each([
  "from=2026-03-01",
  "to=2026-03-01",
  "from=&to=2026-03-01",
  "from=2026-02-30&to=2026-03-01",
  "from=2026-03-02&to=2026-03-01",
  "from=2026-3-01&to=2026-03-01",
  "from=2026-01-01&to=2026-04-01",
])(
  "rejects incomplete, invalid, reversed or over90day calendar dates: %s",
  async query => {
    const response = await GET(
      new Request(`https://local.test/api?${query}`),
      context
    );
    expect(response.status).toBe(400);
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockReport).not.toHaveBeenCalled();
  }
);
test("accepts exactly90inclusive calendar dates", async () => {
  const response = await GET(
    new Request(
      "https://local.test/api?from=2026-01-01&to=2026-03-31&timeZone=UTC"
    ),
    context
  );
  expect(response.status).toBe(200);
  expect(mockReport).toHaveBeenCalledWith(
    expect.objectContaining({
      start: new Date("2026-01-01T00:00:00Z"),
      end: new Date("2026-04-01T00:00:00Z"),
    })
  );
});
test("missing projection dependency is unavailable rather than empty", async () => {
  mockReport.mockRejectedValue(new Error("private"));
  const response = await GET(new Request("https://local.test/api"), context);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private");
});
