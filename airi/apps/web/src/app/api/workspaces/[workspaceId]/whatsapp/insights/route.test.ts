const mockAccess = jest.fn(),
  mockEnable = jest.fn(),
  mockRole = jest.fn();
jest.mock("@/lib/supabase/workspace-api-access", () => ({
  requireWorkspaceApiAccess: (...args: unknown[]) => mockAccess(...args),
}));
jest.mock("@/lib/analytics/whatsapp-insights-activation", () => ({
  enableWhatsAppTemplateInsights: (...args: unknown[]) => mockEnable(...args),
}));
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn() },
}));
import { GET, POST } from "./route";

const context = { params: Promise.resolve({ workspaceId: "w" }) };
const roleQuery = {
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  maybeSingle: () => mockRole(),
};
const post = (body: unknown) =>
  POST(
    new Request("https://local.test/api", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    context
  );
beforeEach(() => {
  jest.clearAllMocks();
  mockAccess.mockResolvedValue({
    ok: true,
    userId: "u",
    supabase: { from: jest.fn(() => roleQuery) },
  });
  mockRole.mockResolvedValue({ data: { role: "admin" }, error: null });
  mockEnable.mockResolvedValue({
    outcome: "enabled",
    sourceId: "s1",
    accountKey: "waba-1",
  });
});

test("tells members whether they can enable insights", async () => {
  mockRole.mockResolvedValueOnce({ data: { role: "member" }, error: null });
  const response = await GET(new Request("https://local.test/api"), context);
  await expect(response.json()).resolves.toEqual({ canManage: false });
  expect(roleQuery.eq).toHaveBeenCalledWith("workspace_id", "w");
  expect(roleQuery.eq).toHaveBeenCalledWith("user_id", "u");
  const admin = await GET(new Request("https://local.test/api"), context);
  await expect(admin.json()).resolves.toEqual({ canManage: true });
});

test("non-members are rejected before any role or Meta call", async () => {
  mockAccess.mockResolvedValue({
    ok: false,
    response: new Response(null, { status: 401 }),
  });
  expect((await post({ sourceId: "s1" })).status).toBe(401);
  expect(
    (await GET(new Request("https://local.test/api"), context)).status
  ).toBe(401);
  expect(mockEnable).not.toHaveBeenCalled();
});

test.each([
  [{ data: { role: "member" }, error: null }],
  [{ data: null, error: null }],
  [{ data: { role: "owner" }, error: { message: "rls" } }],
])("only admins can enable insights (%#)", async roleRow => {
  mockRole.mockResolvedValueOnce(roleRow);
  const response = await post({ sourceId: "s1" });
  expect(response.status).toBe(403);
  expect(mockEnable).not.toHaveBeenCalled();
});

test.each(["not json", {}, { sourceId: "" }, { sourceId: "x".repeat(129) }])(
  "rejects a missing source %#",
  async body => {
    expect((await post(body)).status).toBe(400);
    expect(mockEnable).not.toHaveBeenCalled();
  }
);

test("an admin enables insights for a source in this workspace", async () => {
  mockRole.mockResolvedValueOnce({ data: { role: "admin" }, error: null });
  const response = await post({ sourceId: " s1 " });
  expect(response.status).toBe(200);
  expect(mockEnable).toHaveBeenCalledWith({ workspaceId: "w", sourceId: "s1" });
  await expect(response.json()).resolves.toEqual({
    outcome: "enabled",
    sourceId: "s1",
    cooldownUntil: null,
  });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

test.each([
  ["already_enabled", 200],
  ["not_found", 404],
  ["not_connected", 409],
  ["permission_required", 409],
  ["busy", 409],
  ["unsupported", 422],
  ["rate_limited", 429],
  ["unavailable", 503],
])("maps outcome %s to HTTP %i", async (outcome, status) => {
  mockEnable.mockResolvedValueOnce({
    outcome,
    sourceId: "s1",
    accountKey: null,
  });
  const response = await post({ sourceId: "s1" });
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({ outcome });
});

test("an unexpected failure is reported without internals", async () => {
  mockEnable.mockRejectedValueOnce(new Error("private database detail"));
  const response = await post({ sourceId: "s1" });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private");
});
