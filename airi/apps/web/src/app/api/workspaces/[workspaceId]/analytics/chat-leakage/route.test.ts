const mockAccess = jest.fn(),
  mockQuery = jest.fn(),
  mockPolicy = jest.fn(),
  mockConnect = jest.fn();
jest.mock("@/lib/supabase/workspace-api-access", () => ({
  requireWorkspaceApiAccess: (...args: unknown[]) => mockAccess(...args),
}));
jest.mock("@/lib/analytics/chat-leakage", () => ({
  CHAT_LEAKAGE_KINDS: [
    "needs_reply",
    "aged_unanswered",
    "stalled",
    "handoff",
    "ghosted",
    "qualified_unanswered",
  ],
  getChatLeakageReport: (...args: unknown[]) => mockQuery(...args),
}));
jest.mock("@/lib/analytics/analytics-policy", () => ({
  getAnalyticsPolicy: (...args: unknown[]) => mockPolicy(...args),
}));
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: () => mockConnect(),
}));
import { GET } from "./route";
const context = { params: Promise.resolve({ workspaceId: "w" }) };
beforeEach(() => {
  jest.clearAllMocks();
  mockAccess.mockResolvedValue({
    ok: true,
    supabase: { identity: "authorized" },
  });
  mockPolicy.mockResolvedValue({
    qualifiedStageKeys: ["proposal"],
    revision: 3,
  });
  mockQuery.mockResolvedValue({ status: "ready", audience: [] });
});
test("denied access never reads policy or audience", async () => {
  mockAccess.mockResolvedValue({
    ok: false,
    response: new Response(null, { status: 403 }),
  });
  expect(
    (await GET(new Request("https://local.test/api"), context)).status
  ).toBe(403);
  expect(mockPolicy).not.toHaveBeenCalled();
  expect(mockQuery).not.toHaveBeenCalled();
});
test.each([
  "kind=bad",
  "qualifiedOnly=maybe",
  `sourceIds=${"s".repeat(129)}`,
  Array.from({ length: 21 }, (_, n) => `ownerIds=u${n}`).join("&"),
])("rejects malformed filters %s", async query => {
  expect(
    (await GET(new Request(`https://local.test/api?${query}`), context)).status
  ).toBe(400);
  expect(mockQuery).not.toHaveBeenCalled();
});
test("forwards the exact authorized scope and workspace qualification policy", async () => {
  const response = await GET(
    new Request(
      "https://local.test/api?kind=qualified_unanswered&sourceIds=s&sourceIds=s&adIds=a&ownerIds=u&channels=whatsapp&qualifiedOnly=1"
    ),
    context
  );
  expect(response.status).toBe(200);
  expect(mockQuery).toHaveBeenCalledWith({
    workspaceId: "w",
    supabase: { identity: "authorized" },
    qualifiedStageKeys: ["proposal"],
    policyRevision: 3,
    filters: {
      kind: "qualified_unanswered",
      sourceIds: ["s"],
      adIds: ["a"],
      ownerIds: ["u"],
      channels: ["whatsapp"],
      qualifiedOnly: true,
    },
  });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});
test("a read failure is unavailable, not an empty actionable audience", async () => {
  mockQuery.mockRejectedValue(new Error("private database error"));
  const response = await GET(new Request("https://local.test/api"), context);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private");
});
