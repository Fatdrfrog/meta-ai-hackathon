const mockAuthenticateRequest = jest.fn();
const mockFlush = jest.fn();
const mockLogInfo = jest.fn();
const mockListScenarios = jest.fn();

jest.mock("@/lib/api-auth", () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
  hasPermission: (
    key: { permissions: Record<string, boolean> },
    permission: string
  ) => key.permissions[permission] === true,
}));
jest.mock("@/lib/observability/server-logs", () => ({
  // The route builds its logger at import time, before these consts exist.
  createServerLogger: () => ({
    info: (...args: unknown[]) => mockLogInfo(...args),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  flushServerLogsAfterResponse: () => mockFlush(),
}));
jest.mock("@/lib/airi-mcp/mongo-data-provider", () => ({
  createAiriMcpMongoDataProvider: () => ({
    getAnalyticsCounts: jest.fn(),
    listConversations: jest.fn(),
    listWhatsAppTemplates: jest.fn(),
    listScenarios: (...args: unknown[]) => mockListScenarios(...args),
  }),
}));

import * as route from "./route";

const URL = "https://www.airi.chat/api/mcp";

function post(headers: Record<string, string> = {}) {
  return new Request(URL, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-06-18",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_scenarios", arguments: { status: "active" } },
    }),
  });
}

describe("/api/mcp route", () => {
  const originalFlag = process.env.AIRI_MCP_ENABLED;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.AIRI_MCP_ENABLED;
    mockAuthenticateRequest.mockResolvedValue({
      apiKey: {
        id: "key-1",
        workspace_id: "workspace-1",
        permissions: { read: true, templates: true },
      },
      error: null,
    });
    mockListScenarios.mockResolvedValue({
      items: [],
      hasMore: false,
      nextCursor: null,
    });
  });

  afterAll(() => {
    if (originalFlag === undefined) delete process.env.AIRI_MCP_ENABLED;
    else process.env.AIRI_MCP_ENABLED = originalFlag;
  });

  it("runs on Node, uncached, within 30 seconds", () => {
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.maxDuration).toBeLessThanOrEqual(30);
  });

  it("is off by default", async () => {
    const response = await route.POST(
      post({ Authorization: "Bearer sk_live_key" })
    );
    expect(response.status).toBe(404);
    expect((await route.GET(new Request(URL))).status).toBe(404);
    expect(mockAuthenticateRequest).not.toHaveBeenCalled();
  });

  it.each(["GET", "PUT", "PATCH", "DELETE", "OPTIONS"] as const)(
    "answers %s with 405 when enabled",
    async method => {
      process.env.AIRI_MCP_ENABLED = "1";
      const response = await route[method](new Request(URL, { method }));
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
  );

  it("authenticates with the shared limiter and no per-instance fallback", async () => {
    process.env.AIRI_MCP_ENABLED = "1";
    const request = post({ Authorization: "Bearer sk_live_key" });
    const response = await route.POST(request);

    expect(response.status).toBe(200);
    expect(mockAuthenticateRequest).toHaveBeenCalledWith(request, {
      requireDistributedRateLimit: true,
    });
    expect(mockListScenarios).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1", status: "active" })
    );
    expect(mockFlush).toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(
      "airi_mcp.tool_call",
      expect.objectContaining({ keyId: "key-1", outcome: "ok" })
    );
  });

  it("never falls back to X-API-Key", async () => {
    process.env.AIRI_MCP_ENABLED = "1";
    const response = await route.POST(post({ "X-API-Key": "sk_live_key" }));
    expect(response.status).toBe(401);
    expect(mockAuthenticateRequest).not.toHaveBeenCalled();
  });
});
