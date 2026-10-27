jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));

import {
  Client,
  StreamableHTTPClientTransport,
  type ClientOptions,
} from "@modelcontextprotocol/client";
import { createAiriMcpRequestHandler } from "../handler";
import {
  createTestDeps,
  FIXTURE_KEY,
  FULL_READ_KEY,
  MCP_URL,
  PROMPT_INJECTION,
  WORKSPACE_ID,
} from "./fixtures";

const ALL_TOOLS = [
  "get_analytics_summary",
  "list_conversations",
  "list_whatsapp_templates",
  "list_scenarios",
];

const TOOL_ARGUMENTS: Record<string, Record<string, unknown>> = {
  get_analytics_summary: { period: "7d" },
  list_conversations: { limit: 2 },
  list_whatsapp_templates: { status: "APPROVED", limit: 10 },
  list_scenarios: { status: "all", limit: 3 },
};

type Exchange = {
  method: string;
  status: number;
  contentType: string | null;
  headers: Headers;
  body: string | null;
};

function connectClient(options: ClientOptions) {
  const { deps, data, logger } = createTestDeps(FULL_READ_KEY);
  const handler = createAiriMcpRequestHandler(deps);
  const exchanges: Exchange[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${FIXTURE_KEY}` } },
    fetch: async (url, init) => {
      const request = new Request(url, init);
      const response = await handler(request);
      exchanges.push({
        method: request.method,
        status: response.status,
        contentType: response.headers.get("content-type"),
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : null,
      });
      return response;
    },
  });
  const client = new Client(
    { name: "airi-mcp-integration", version: "1.0.0" },
    options
  );
  return { client, transport, exchanges, data, logger, handler };
}

describe("Airi MCP over the real MCP client", () => {
  const originalFlag = process.env.AIRI_MCP_ENABLED;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    process.env.AIRI_MCP_ENABLED = "1";
    // createMcpHandler warns once that JSON mode drops mid-call notifications.
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    if (originalFlag === undefined) delete process.env.AIRI_MCP_ENABLED;
    else process.env.AIRI_MCP_ENABLED = originalFlag;
  });

  async function exerciseEveryTool(
    harness: ReturnType<typeof connectClient>,
    expectedEra: "legacy" | "modern"
  ) {
    const { client, transport, exchanges, data, logger } = harness;
    await client.connect(transport);
    try {
      expect(client.getProtocolEra()).toBe(expectedEra);
      const { tools } = await client.listTools();
      expect(tools.map(tool => tool.name).sort()).toEqual(
        [...ALL_TOOLS].sort()
      );
      for (const tool of tools) {
        expect(tool.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
        expect(tool.outputSchema).toBeDefined();
      }

      for (const name of ALL_TOOLS) {
        // listTools cached the output schemas, so callTool validates
        // structuredContent against them and throws on a mismatch.
        const result = await client.callTool({
          name,
          arguments: TOOL_ARGUMENTS[name],
        });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toEqual(expect.any(Object));
        const [summary, json] = result.content as Array<{
          type: string;
          text: string;
        }>;
        expect(summary?.type).toBe("text");
        expect(summary?.text).not.toContain(PROMPT_INJECTION);
        expect(JSON.parse(json?.text ?? "null")).toEqual(
          result.structuredContent
        );
      }

      const unknown = await client.callTool({ name: "delete_everything" });
      expect(unknown.isError).toBe(true);
    } finally {
      await client.close();
    }

    for (const exchange of exchanges.filter(entry => entry.method === "POST")) {
      if (exchange.status === 202) continue;
      expect(exchange.contentType).toMatch(/^application\/json/u);
    }
    expect(
      exchanges.some(entry => entry.contentType?.includes("event-stream"))
    ).toBe(false);
    for (const call of [
      ...data.getAnalyticsCounts.mock.calls,
      ...data.listConversations.mock.calls,
      ...data.listWhatsAppTemplates.mock.calls,
      ...data.listScenarios.mock.calls,
    ]) {
      expect(call[0]).toMatchObject({ workspaceId: WORKSPACE_ID });
    }
    expect(logger.info).toHaveBeenCalledTimes(ALL_TOOLS.length);
    return exchanges;
  }

  it.each(["2025-03-26", "2025-06-18", "2025-11-25"])(
    "serves a %s client with plain JSON responses",
    async version => {
      const harness = connectClient({ supportedProtocolVersions: [version] });
      const exchanges = await exerciseEveryTool(harness, "legacy");
      // The SDK client opens a GET stream after initialize; it gets 405.
      expect(
        exchanges.filter(entry => entry.method === "GET").map(e => e.status)
      ).toEqual(expect.arrayContaining([405]));
    }
  );

  it("negotiates the client's version during initialize", async () => {
    const harness = connectClient({
      supportedProtocolVersions: ["2025-06-18"],
    });
    await harness.client.connect(harness.transport);
    try {
      expect(harness.client.getNegotiatedProtocolVersion()).toBe("2025-06-18");
      expect(harness.client.getServerVersion()).toMatchObject({ name: "airi" });
      expect(harness.client.getInstructions()).toContain(
        "untrusted_customer_content"
      );
    } finally {
      await harness.client.close();
    }
  });

  it("serves a 2026-07-28 client pinned to that revision", async () => {
    const harness = connectClient({
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    });
    const exchanges = await exerciseEveryTool(harness, "modern");
    expect(exchanges.some(entry => entry.method === "GET")).toBe(false);
  });

  it("serves a 2026-07-28 client that negotiates automatically", async () => {
    const harness = connectClient({ versionNegotiation: { mode: "auto" } });
    await exerciseEveryTool(harness, "modern");
  });

  it("refuses 2026-07-28 subscription streams with JSON instead of SSE", async () => {
    const harness = connectClient({
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    });
    await harness.client.connect(harness.transport);
    try {
      await harness.client.listTools();
    } finally {
      await harness.client.close();
    }
    // Replay the client's own envelope on a listen request.
    const listToolsExchange = harness.exchanges.find(entry =>
      entry.body?.includes('"tools/list"')
    );
    const listTools = JSON.parse(listToolsExchange?.body ?? "{}") as {
      params?: { _meta?: Record<string, unknown> };
    };
    const headers = new Headers(listToolsExchange?.headers);
    headers.set("Mcp-Method", "subscriptions/listen");
    const response = await harness.handler(
      new Request(MCP_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 99,
          method: "subscriptions/listen",
          params: {
            _meta: listTools.params?._meta,
            notifications: { toolsListChanged: true },
          },
        }),
      })
    );

    expect(response.headers.get("content-type")).toMatch(/^application\/json/u);
    expect(await response.json()).toMatchObject({
      id: 99,
      error: { code: -32603 },
    });
  });
});
