jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));

import {
  AIRI_MCP_MAX_BODY_BYTES,
  createAiriMcpRequestHandler,
} from "../handler";
import { AIRI_MCP_TOOL_CALL_EVENT, AIRI_MCP_TOOL_FAILED } from "../server";
import {
  buildApiKey,
  createTestDeps,
  FIXTURE_KEY,
  FULL_READ_KEY,
  MCP_URL,
  PROMPT_INJECTION,
  WHATSAPP_PHONE,
  WORKSPACE_ID,
} from "./fixtures";

const LEGACY_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
  "MCP-Protocol-Version": "2025-06-18",
};

function mcpRequest(
  body: unknown,
  headers: Record<string, string> = {},
  init: RequestInit = {}
) {
  return new Request(MCP_URL, {
    method: "POST",
    headers: {
      ...LEGACY_HEADERS,
      Authorization: `Bearer ${FIXTURE_KEY}`,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

function callTool(name: string, args: Record<string, unknown> = {}, id = 1) {
  return mcpRequest({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

function withoutHeader(name: string) {
  const headers = new Headers({ ...LEGACY_HEADERS });
  headers.delete(name);
  return headers;
}

describe("Airi MCP HTTP admission", () => {
  const originalFlag = process.env.AIRI_MCP_ENABLED;

  beforeEach(() => {
    process.env.AIRI_MCP_ENABLED = "1";
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.AIRI_MCP_ENABLED;
    else process.env.AIRI_MCP_ENABLED = originalFlag;
  });

  it.each([undefined, "0", "true", "yes"])(
    "answers 404 for every method while AIRI_MCP_ENABLED is %s",
    async flag => {
      if (flag === undefined) delete process.env.AIRI_MCP_ENABLED;
      else process.env.AIRI_MCP_ENABLED = flag;
      const { deps, authenticate } = createTestDeps();
      const handler = createAiriMcpRequestHandler(deps);

      expect((await handler(callTool("list_scenarios"))).status).toBe(404);
      expect((await handler(new Request(MCP_URL))).status).toBe(404);
      expect(authenticate).not.toHaveBeenCalled();
    }
  );

  it.each(["GET", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "rejects %s with 405 and Allow: POST",
    async method => {
      const { deps, authenticate } = createTestDeps();
      const response = await createAiriMcpRequestHandler(deps)(
        new Request(MCP_URL, {
          method,
          headers: { Authorization: `Bearer ${FIXTURE_KEY}` },
        })
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(authenticate).not.toHaveBeenCalled();
    }
  );

  it("rejects browser origins before authentication", async () => {
    const { deps, authenticate } = createTestDeps();
    const response = await createAiriMcpRequestHandler(deps)(
      mcpRequest(
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        {
          Origin: "https://evil.example",
        }
      )
    );
    expect(response.status).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it.each([
    ["no Authorization header", {}],
    ["only an X-API-Key header", { "X-API-Key": FIXTURE_KEY }],
    ["a session cookie", { Cookie: "sb-access-token=session" }],
    ["a key without the Bearer scheme", { Authorization: FIXTURE_KEY }],
    ["a non-API-key bearer token", { Authorization: "Bearer eyJhbGciOi" }],
    ["a lowercase scheme", { Authorization: `bearer ${FIXTURE_KEY}` }],
  ])("answers 401 with a Bearer challenge for %s", async (_name, headers) => {
    const { deps, authenticate } = createTestDeps();
    const request = new Request(MCP_URL, {
      method: "POST",
      headers: { ...LEGACY_HEADERS, ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const response = await createAiriMcpRequestHandler(deps)(request);

    expect(response.status).toBe(401);
    // A bare challenge: no resource_metadata, so clients do not start OAuth.
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(await response.json()).toMatchObject({
      code: "AIRI_MCP_UNAUTHORIZED",
    });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("adds the Bearer challenge to invalid or expired key responses", async () => {
    const { deps, authenticate } = createTestDeps();
    authenticate.mockResolvedValue({
      apiKey: null,
      error: new Response(
        JSON.stringify({ error: "Invalid or expired API key" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      ),
    });
    const request = mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const response = await createAiriMcpRequestHandler(deps)(request);

    expect(authenticate).toHaveBeenCalledWith(request);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(await response.json()).toEqual({
      error: "Invalid or expired API key",
    });
  });

  it.each([
    [503, { "Retry-After": "5" }],
    [429, { "Retry-After": "12", "X-RateLimit-Remaining": "0" }],
  ])(
    "passes the shared limiter's %s through unchanged",
    async (status, headers) => {
      const { deps, authenticate, data } = createTestDeps();
      authenticate.mockResolvedValue({
        apiKey: null,
        error: Response.json({ error: "limited" }, { status, headers }),
      });
      const response = await createAiriMcpRequestHandler(deps)(
        callTool("get_analytics_summary")
      );
      expect(response.status).toBe(status);
      expect(response.headers.get("retry-after")).toBe(headers["Retry-After"]);
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(data.getAnalyticsCounts).not.toHaveBeenCalled();
    }
  );

  it("forbids keys that unlock no tool, including write-only keys", async () => {
    const { deps } = createTestDeps(
      buildApiKey({
        read: false,
        write: true,
        conversations: true,
        analytics: true,
        templates: true,
      })
    );
    const response = await createAiriMcpRequestHandler(deps)(
      mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "AIRI_MCP_FORBIDDEN" });
  });

  it("requires a JSON body", async () => {
    const { deps } = createTestDeps();
    const response = await createAiriMcpRequestHandler(deps)(
      mcpRequest("{}", { "Content-Type": "text/plain" })
    );
    expect(response.status).toBe(415);
  });

  it("bounds the request body", async () => {
    const { deps, data } = createTestDeps();
    const response = await createAiriMcpRequestHandler(deps)(
      callTool("list_conversations", {
        padding: "x".repeat(AIRI_MCP_MAX_BODY_BYTES),
      })
    );
    expect(response.status).toBe(413);
    expect(data.listConversations).not.toHaveBeenCalled();
  });

  it("answers malformed JSON with a JSON-RPC parse error", async () => {
    const { deps } = createTestDeps();
    const response = await createAiriMcpRequestHandler(deps)(
      mcpRequest("{not json")
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32700 },
    });
  });

  it("refuses JSON-RPC batches so one rate-limit token admits one call", async () => {
    const { deps, data } = createTestDeps();
    const response = await createAiriMcpRequestHandler(deps)(
      mcpRequest([
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_scenarios" },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "list_scenarios" },
        },
      ])
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32600 } });
    expect(data.listScenarios).not.toHaveBeenCalled();
  });

  it("answers a stateless 2025 request with JSON, no session and no cookies", async () => {
    const { deps } = createTestDeps();
    const response = await createAiriMcpRequestHandler(deps)(
      callTool("list_scenarios")
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/u);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps the 2025 transport's Accept requirement", async () => {
    const { deps } = createTestDeps();
    const response = await createAiriMcpRequestHandler(deps)(
      new Request(MCP_URL, {
        method: "POST",
        headers: (() => {
          const headers = withoutHeader("Accept");
          headers.set("Accept", "application/json");
          headers.set("Authorization", `Bearer ${FIXTURE_KEY}`);
          return headers;
        })(),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    );
    expect(response.status).toBe(406);
  });

  it("returns a generic 500 when admission itself fails", async () => {
    const { deps, authenticate, logger } = createTestDeps();
    authenticate.mockRejectedValue(new Error("supabase://secret-host down"));
    const response = await createAiriMcpRequestHandler(deps)(
      callTool("list_scenarios")
    );
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret-host");
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      "secret-host"
    );
  });
});

describe("Airi MCP tool-call logging and errors", () => {
  const originalFlag = process.env.AIRI_MCP_ENABLED;

  beforeEach(() => {
    process.env.AIRI_MCP_ENABLED = "1";
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.AIRI_MCP_ENABLED;
    else process.env.AIRI_MCP_ENABLED = originalFlag;
  });

  async function rpcResult(response: Response) {
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: {
        isError?: boolean;
        content: Array<{ text: string }>;
        structuredContent?: unknown;
      };
    };
    return body.result;
  }

  it("logs one metadata-only line per tool call", async () => {
    const { deps, logger } = createTestDeps();
    const result = await rpcResult(
      await createAiriMcpRequestHandler(deps)(
        callTool("list_conversations", { limit: 2, status: "open" })
      )
    );
    expect(result.isError).toBeFalsy();

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    const [message, context] = logger.info.mock.calls[0]!;
    expect(message).toBe(AIRI_MCP_TOOL_CALL_EVENT);
    expect(context).toEqual({
      event: AIRI_MCP_TOOL_CALL_EVENT,
      keyId: FULL_READ_KEY.id,
      workspaceId: WORKSPACE_ID,
      tool: "list_conversations",
      outcome: "ok",
      latencyMs: expect.any(Number),
      itemCount: 2,
    });
    const logged = JSON.stringify(logger.info.mock.calls);
    expect(logged).not.toContain(FIXTURE_KEY);
    expect(logged).not.toContain("open");
    expect(logged).not.toContain("Aigerim");
    expect(logged).not.toContain(PROMPT_INJECTION);
    expect(logged).not.toContain(WHATSAPP_PHONE);
  });

  it("logs unknown tools as denied without echoing the requested name", async () => {
    const { deps, logger } = createTestDeps();
    const result = await rpcResult(
      await createAiriMcpRequestHandler(deps)(callTool("drop_database_now"))
    );
    expect(result.isError).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      AIRI_MCP_TOOL_CALL_EVENT,
      expect.objectContaining({
        tool: "unknown",
        outcome: "denied",
        reason: "not_available",
        itemCount: 0,
      })
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
      "drop_database_now"
    );
  });

  it("reports invalid arguments as a tool error without running the query", async () => {
    const { deps, data, logger } = createTestDeps();
    const result = await rpcResult(
      await createAiriMcpRequestHandler(deps)(
        callTool("list_conversations", { limit: 500 })
      )
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^Invalid arguments: limit:/u);
    expect(data.listConversations).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      AIRI_MCP_TOOL_CALL_EVENT,
      expect.objectContaining({
        outcome: "denied",
        reason: "invalid_arguments",
      })
    );
  });

  it("turns data failures into a generic tool error and an error log", async () => {
    const { deps, data, logger } = createTestDeps();
    data.listWhatsAppTemplates.mockRejectedValue(
      Object.assign(new Error("MongoServerError: mongodb+srv://user:pw@prod"), {
        stack: "at /var/task/apps/web/src/secret.ts:1:1",
      })
    );
    const response = await createAiriMcpRequestHandler(deps)(
      callTool("list_whatsapp_templates")
    );
    const text = await response.clone().text();
    const result = await rpcResult(response);

    expect(result).toEqual({
      content: [{ type: "text", text: AIRI_MCP_TOOL_FAILED }],
      isError: true,
    });
    expect(text).not.toContain("mongodb");
    expect(text).not.toContain("secret.ts");
    expect(logger.error).toHaveBeenCalledWith(
      AIRI_MCP_TOOL_CALL_EVENT,
      undefined,
      expect.objectContaining({
        tool: "list_whatsapp_templates",
        outcome: "error",
        reason: "failed",
      })
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("mongodb");
  });
});
