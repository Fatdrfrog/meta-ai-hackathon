jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));

import type { ApiKeyData } from "@/lib/api-auth";
import { createAiriMcpRequestHandler } from "../handler";
import { canReadAiriMcpCatalog } from "../permissions";
import { AIRI_MCP_TOOL_UNAVAILABLE } from "../server";
import { buildApiKey, createTestDeps, FIXTURE_KEY, MCP_URL } from "./fixtures";

const ANALYTICS = "get_analytics_summary";
const CONVERSATIONS = "list_conversations";
const TEMPLATES = "list_whatsapp_templates";
const SCENARIOS = "list_scenarios";
const ALL_TOOLS = [ANALYTICS, CONVERSATIONS, TEMPLATES, SCENARIOS];

const PROVIDER_METHOD = {
  [ANALYTICS]: "getAnalyticsCounts",
  [CONVERSATIONS]: "listConversations",
  [TEMPLATES]: "listWhatsAppTemplates",
  [SCENARIOS]: "listScenarios",
} as const;

function rpc(method: string, params?: Record<string, unknown>) {
  return new Request(MCP_URL, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-06-18",
      Authorization: `Bearer ${FIXTURE_KEY}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function result(response: Response) {
  expect(response.status).toBe(200);
  return ((await response.json()) as { result: Record<string, unknown> })
    .result;
}

const MATRIX: Array<[string, ApiKeyData["permissions"], string[]]> = [
  // Legacy read keys inherit both v1 read scopes, never templates.
  [
    "legacy read key without domain flags",
    { read: true },
    [ANALYTICS, CONVERSATIONS],
  ],
  [
    "new UI default (analytics:false)",
    { read: true, write: false, conversations: true, analytics: false },
    [CONVERSATIONS],
  ],
  ["conversations:false", { read: true, conversations: false }, [ANALYTICS]],
  [
    "templates flag on a read key",
    { read: true, templates: true },
    [ANALYTICS, CONVERSATIONS, TEMPLATES, SCENARIOS],
  ],
  [
    "templates flag with both v1 scopes denied",
    { read: true, conversations: false, analytics: false, templates: true },
    [TEMPLATES, SCENARIOS],
  ],
  [
    "write grants nothing on top of read",
    { read: true, write: true, bulk_send: true, analytics: false },
    [CONVERSATIONS],
  ],
];

describe("Airi MCP permission matrix", () => {
  const originalFlag = process.env.AIRI_MCP_ENABLED;

  beforeEach(() => {
    process.env.AIRI_MCP_ENABLED = "1";
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.AIRI_MCP_ENABLED;
    else process.env.AIRI_MCP_ENABLED = originalFlag;
  });

  describe.each(MATRIX)("%s", (_name, permissions, allowed) => {
    it("lists only the tools the key may call", async () => {
      const { deps } = createTestDeps(buildApiKey(permissions));
      const listed = await result(
        await createAiriMcpRequestHandler(deps)(rpc("tools/list"))
      );
      expect(
        (listed.tools as Array<{ name: string }>).map(tool => tool.name)
      ).toEqual(allowed);
    });

    it.each(ALL_TOOLS)("re-checks permission when calling %s", async name => {
      const { deps, data } = createTestDeps(buildApiKey(permissions));
      const called = await result(
        await createAiriMcpRequestHandler(deps)(
          rpc("tools/call", { name, arguments: {} })
        )
      );
      const providerMethod =
        data[PROVIDER_METHOD[name as keyof typeof PROVIDER_METHOD]];
      if (allowed.includes(name)) {
        expect(called.isError).toBeFalsy();
        expect(providerMethod).toHaveBeenCalledTimes(1);
      } else {
        // Indistinguishable from a tool that does not exist.
        expect(called).toEqual({
          content: [{ type: "text", text: AIRI_MCP_TOOL_UNAVAILABLE }],
          isError: true,
        });
        expect(providerMethod).not.toHaveBeenCalled();
      }
    });
  });

  it.each([
    [
      "read:false with every domain flag",
      { read: false, conversations: true, analytics: true, templates: true },
    ],
    ["read missing", { conversations: true, analytics: true }],
    [
      "both v1 scopes denied and no templates flag",
      { read: true, conversations: false, analytics: false },
    ],
    [
      "templates given as a string",
      {
        read: true,
        conversations: false,
        analytics: false,
        templates: "true" as unknown as boolean,
      },
    ],
  ])("refuses the connection for %s", async (_name, permissions) => {
    const { deps } = createTestDeps(buildApiKey(permissions));
    const response = await createAiriMcpRequestHandler(deps)(rpc("tools/list"));
    expect(response.status).toBe(403);
  });

  it("answers an unknown tool exactly like a disallowed one", async () => {
    const { deps } = createTestDeps(buildApiKey({ read: true }));
    const unknown = await result(
      await createAiriMcpRequestHandler(deps)(
        rpc("tools/call", { name: "send_message", arguments: {} })
      )
    );
    const disallowed = await result(
      await createAiriMcpRequestHandler(deps)(
        rpc("tools/call", { name: TEMPLATES, arguments: {} })
      )
    );
    expect(unknown).toEqual(disallowed);
  });

  it("requires both read and an explicit templates flag for the catalog", () => {
    expect(
      canReadAiriMcpCatalog(buildApiKey({ read: true, templates: true }))
    ).toBe(true);
    expect(canReadAiriMcpCatalog(buildApiKey({ read: true }))).toBe(false);
    expect(canReadAiriMcpCatalog(buildApiKey({ templates: true }))).toBe(false);
    expect(
      canReadAiriMcpCatalog(buildApiKey({ read: true, write: true }))
    ).toBe(false);
  });
});
