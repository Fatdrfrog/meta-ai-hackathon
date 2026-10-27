const mockReadPrecondition = jest.fn();
jest.mock("./preconditions", () => ({
  ...jest.requireActual("./preconditions"),
  getMetaAdsMcpReadPrecondition: (...args: unknown[]) =>
    mockReadPrecondition(...args),
}));

const mockResolveAccess = jest.fn();
jest.mock("./readiness-service", () => ({
  ...jest.requireActual("./readiness-service"),
  resolveWorkspaceMetaAdsMcpAccessToken: (...args: unknown[]) =>
    mockResolveAccess(...args),
}));

jest.mock("@icecore/shared/lib/cache", () => ({
  buildCacheKey: (namespace: string, parts: string[]) =>
    [namespace, ...parts].join(":"),
  cache: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
  },
}));

const mockListPendingTransactions = jest.fn();
jest.mock("@/lib/airi-chats/meta-ads-mcp-confirmation-store", () => ({
  listAiriMetaAdsMcpPendingTransactions: (...args: unknown[]) =>
    mockListPendingTransactions(...args),
}));

jest.mock("./account-access", () => ({
  readMetaAdsMcpAccountAccess: jest.fn(),
}));

jest.mock("./creative-assets", () => ({
  loadMetaAdsMcpCreativeAssetReferences: jest.fn(async () => []),
  buildMetaAdsMcpCreativeAssetContext: () => "No Creative Assets attached.",
  materializeMetaAdsMcpCreativeAssetArguments: jest.fn(
    async ({ arguments: toolArguments }) => toolArguments
  ),
  materializeMetaAdsMcpMutationArguments: jest.fn(),
}));

// Native turns never go through the text facade.
jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: jest.fn(async () => {
    throw new Error("The native turn must not call the text facade");
  }),
  getHeavyTextModel: () => "heavy-text-model",
  getStructuredJsonGenerationConfig: () => ({}),
}));

const mockResolveBilling = jest.fn(async (): Promise<unknown> => null);
jest.mock("@/lib/ai/workspace-ai-policy", () => ({
  withWorkspaceTextAiAction: (_scope: unknown, run: () => Promise<unknown>) =>
    run(),
  resolveWorkspaceTextAiBilling: () => mockResolveBilling(),
  reserveWorkspaceTextAiSpend: jest.fn(async () => null),
  settleWorkspaceTextAiSpend: jest.fn(async () => undefined),
}));

const mockRecordTrace = jest.fn(async (..._args: unknown[]) => true);
jest.mock("@/lib/llm-analytics/events", () => ({
  recordLlmTraceAnalyticsEvent: (...args: unknown[]) =>
    mockRecordTrace(...args),
}));

jest.mock("@/lib/supabase/company-users", () => ({
  getCompanyIdForWorkspace: jest.fn(async () => "company-1"),
}));

jest.mock("@/lib/crypto", () => ({
  decryptMaybeString: (value: unknown) =>
    typeof value === "string" ? value : "mcp-token",
}));

jest.mock("./client", () => {
  class MetaAdsMcpClientError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }

  class MetaAdsMcpToolResultError extends Error {
    readonly toolName: string;
    readonly result: unknown;

    constructor(toolName: string, message: string, result: unknown) {
      super(message);
      this.name = "MetaAdsMcpToolResultError";
      this.toolName = toolName;
      this.result = result;
    }
  }

  return {
    MetaAdsMcpClientError,
    MetaAdsMcpToolResultError,
    createMetaAdsMcpSession: jest.fn(() => ({ closed: false })),
    initializeMetaAdsMcpSession: jest.fn(async () => undefined),
    listMetaAdsMcpTools: jest.fn(),
    callMetaAdsMcpTool: jest.fn(),
    closeMetaAdsMcpSession: jest.fn(async () => undefined),
  };
});

const mockStream = jest.fn();
jest.mock("@anthropic-ai/sdk", () => {
  const actual = jest.requireActual("@anthropic-ai/sdk");
  class MockAnthropic {
    messages = {
      stream: (...args: unknown[]) => mockStream(...args),
    };
  }
  return { ...actual, __esModule: true, default: MockAnthropic };
});

import { InternalServerError } from "@anthropic-ai/sdk";
import { chatCompletionWithFallback } from "@/lib/ai";
import { resetAnthropicRuntimeAvailabilityForTesting } from "@/lib/ai/anthropic-config";
import { resetAnthropicClientForTesting } from "@/lib/ai/anthropic-messages";
import { META_ADS_MCP_WRITE_REQUIRED_SCOPES } from "../meta-ads-mcp-readiness";
import {
  callMetaAdsMcpTool,
  closeMetaAdsMcpSession,
  createMetaAdsMcpSession,
  initializeMetaAdsMcpSession,
  listMetaAdsMcpTools,
  MetaAdsMcpToolResultError,
  type MetaAdsMcpCatalog,
  type MetaAdsMcpTool,
} from "./client";
import { prepareMetaAdsMcpTransaction } from "./confirmation-contract.server";
import { runMetaAdsMcpTurn } from "./agent-loop";
import { fieldContextCacheKey, readCachedFieldContext } from "./turn-support";
import { cache } from "@icecore/shared/lib/cache";
import {
  getMetaAdsRequiresClaudeMessage,
  MAX_PREPARED_WRITES_PER_TURN,
  resolveMetaAdsNoticeLanguage,
} from "./native-turn";

const DEFINITION_SHA256 = "a".repeat(64);
const CATALOG_SHA256 = "b".repeat(64);
const THREAD_ID = "507f1f77bcf86cd799439011";

type Block = Record<string, unknown>;
type ScriptedResponse = { content: Block[]; stop_reason: string };
type Request = {
  messages: Array<{ role: string; content: unknown }>;
  tools: Array<{
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
  }>;
  tool_choice: { type: string };
};
type Responder = (request: Request, index: number) => ScriptedResponse | Error;

let responses: Array<ScriptedResponse | Error | Responder> = [];

/**
 * A scripted fake Claude behind the SDK: each stream() call serves the next
 * scripted step; a function step sees the request (to read tool results).
 */
function scriptClaude(...steps: Array<ScriptedResponse | Error | Responder>) {
  responses = steps;
}

function streamFor(request: Request) {
  const index = mockStream.mock.calls.length - 1;
  const step =
    responses.length > 1 ? responses.shift()! : (responses[0] ?? null);
  const resolved = typeof step === "function" ? step(request, index) : step;
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    on(event: string, listener: (...args: unknown[]) => void) {
      (listeners[event] ||= []).push(listener);
      return this;
    },
    async finalMessage() {
      if (!resolved) throw new Error("No scripted Claude response left");
      if (resolved instanceof Error) throw resolved;
      let snapshot = "";
      for (const block of resolved.content) {
        if (block.type !== "text") continue;
        for (const delta of String(block.text).split(/(?<= )/)) {
          snapshot += delta;
          for (const listener of listeners.text || [])
            listener(delta, snapshot);
        }
      }
      return {
        id: `msg_${index}`,
        role: "assistant",
        model: "claude-sonnet-5-5",
        usage: { input_tokens: 100, output_tokens: 20 },
        ...resolved,
      };
    },
  };
}

const toolUse = (id: string, name: string, input: unknown): Block => ({
  type: "tool_use",
  id,
  name,
  input,
});
const thinking = (signature: string): Block => ({
  type: "thinking",
  thinking: "",
  signature,
});
const text = (value: string): Block => ({ type: "text", text: value });
const answer = (value: string): ScriptedResponse => ({
  content: [text(value)],
  stop_reason: "end_turn",
});
const calls = (...blocks: Block[]): ScriptedResponse => ({
  content: blocks,
  stop_reason: "tool_use",
});

function request(index: number): Request {
  return mockStream.mock.calls[index]![0] as Request;
}

/** The tool_result blocks the model received in request `index`. */
function toolResults(index: number) {
  const last = request(index).messages.at(-1)!;
  return last.content as Array<{
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  }>;
}

function createTool(
  name: string,
  inputSchema: Record<string, unknown> = {
    type: "object",
    additionalProperties: true,
  },
  description?: string
): MetaAdsMcpTool {
  return {
    name,
    ...(description ? { description } : {}),
    inputSchema,
    definitionSha256: DEFINITION_SHA256,
  };
}

function createCatalog(tools: MetaAdsMcpTool[]): MetaAdsMcpCatalog {
  return {
    tools,
    catalogSha256: CATALOG_SHA256,
    canonicalSizeBytes: 1_024,
    protocol: {
      era: "legacy",
      protocolVersion: "2025-06-18",
      serverName: "meta-ads-mcp-test",
      serverVersion: "1.0.0",
      capabilities: { tools: {} },
    },
  };
}

function readySupabase(
  selectedAccountEnabled?: boolean,
  selectedAccountQueryable?: boolean
) {
  const now = new Date().toISOString();
  type Query = {
    select(columns: string): Query;
    eq(column: string, value: string): Query;
    order(column: string, options: { ascending: boolean }): Query;
    limit(value: number): Query;
    maybeSingle(): Promise<unknown>;
  };
  const query: Query = {
    select: () => query,
    eq: () => query,
    order: () => query,
    limit: () => query,
    maybeSingle: async () => ({
      data: {
        id: "source-1",
        company_id: "company-1",
        updated_at: now,
        credentials: {
          access_token: "graph-token",
          mcp_access_token: "mcp-token",
          mcp_connection_id: "connection-1",
          mcp_user_id: "mcp-user-1",
          mcp_scope: META_ADS_MCP_WRITE_REQUIRED_SCOPES.join(" "),
          mcp_scopes_verified_at: now,
          mcp_expires_at: "2099-01-01T00:00:00.000Z",
          selected_ad_account_id: "act_123",
          mcp_selected_ad_account: { id: "act_123", currency: "USD" },
          mcp_ad_account_ids: ["act_123"],
          mcp_assets_checked_at: now,
          mcp_provider_probe: {
            checkedAt: now,
            outcome: "success",
            warnings: [],
            ...(selectedAccountEnabled !== undefined
              ? { selectedAccountEnabled }
              : {}),
            ...(selectedAccountQueryable !== undefined
              ? { selectedAccountQueryable }
              : {}),
          },
        },
      },
      error: null,
    }),
  };
  return { from: jest.fn(() => query) };
}

const reportTool = createTool(
  "ads_insights_performance_trend",
  {
    type: "object",
    properties: {
      ad_account_id: { type: "string" },
      client_conversation_id: { type: "string" },
      cursor: { type: "string" },
    },
    required: ["ad_account_id", "client_conversation_id"],
    additionalProperties: false,
  },
  "Performance trend"
);

function turn(
  overrides: Partial<Parameters<typeof runMetaAdsMcpTurn>[0]> = {}
) {
  return runMetaAdsMcpTurn({
    supabase: readySupabase() as never,
    workspaceId: "workspace-1",
    userMessage: "How did my ads do last week?",
    ...overrides,
  });
}

describe("runMetaAdsMcpTurn (native Claude tool use)", () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    responses = [];
    mockStream.mockReset().mockImplementation(streamFor);
    process.env.ANTHROPIC_API_KEY = "test-key";
    resetAnthropicClientForTesting();
    resetAnthropicRuntimeAvailabilityForTesting();
    mockResolveBilling.mockResolvedValue(null);
    mockListPendingTransactions.mockReset().mockResolvedValue([]);
    mockReadPrecondition.mockReset().mockReturnValue({ kind: "ready" });
    mockResolveAccess
      .mockReset()
      .mockImplementation(
        jest.requireActual("./readiness-service")
          .resolveWorkspaceMetaAdsMcpAccessToken
      );
    (listMetaAdsMcpTools as jest.Mock).mockResolvedValue(
      createCatalog([
        createTool("ads_get_ad_accounts", undefined, "List ad accounts"),
        reportTool,
        createTool("ads_create_campaign", undefined, "Create a campaign"),
      ])
    );
    (callMetaAdsMcpTool as jest.Mock)
      .mockReset()
      .mockImplementation(async (params: { tool: MetaAdsMcpTool }) => ({
        ok: true,
        tool: params.tool.name,
      }));
  });

  afterAll(() => {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  });

  it("reads through tool use and answers with Claude's final text", async () => {
    const first = calls(
      thinking("sig-1"),
      toolUse("tu_1", "ads_get_ad_accounts", {})
    );
    scriptClaude(first, answer("You have one active ad account."));

    const result = await turn({
      analytics: { conversationId: "thread-1", messageId: "message-1" },
    });

    expect(callMetaAdsMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: expect.objectContaining({ name: "ads_get_ad_accounts" }),
        sideEffect: "read",
      })
    );
    expect(toolResults(1)).toEqual([
      {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: JSON.stringify({ ok: true, tool: "ads_get_ad_accounts" }),
      },
    ]);
    expect(result.content).toBe("You have one active ad account.");
    expect(result.failureCode).toBeUndefined();
    expect(result.coverage).toMatchObject({
      complete: true,
      successfulReads: 1,
    });
    expect(result.toolTrace).toEqual([
      { name: "ads_get_ad_accounts", sideEffect: "read", status: "executed" },
    ]);
    // One native loop: no planner or summary calls through the facade.
    expect(chatCompletionWithFallback).not.toHaveBeenCalled();
    expect(mockStream).toHaveBeenCalledTimes(2);
    // Each Claude call is metered as its own llm_trace operation.
    expect(mockRecordTrace).toHaveBeenCalledTimes(2);
    for (const [event] of mockRecordTrace.mock.calls) {
      expect(event).toMatchObject({
        workspaceId: "workspace-1",
        conversationId: "thread-1",
        messageId: "message-1",
        operation: "airi_chat.meta_ads_mcp.agent_step",
        sourceService: "web.airi_chat",
        traceId: expect.stringMatching(/^meta_ads_mcp:workspace-1:/),
      });
    }
  });

  it("grounds Claude in business evidence without leaking reader errors", async () => {
    scriptClaude(answer("Compared."));
    const loadBusinessEvidence = jest.fn(async () => "Verified sales: 3");

    await turn({ loadBusinessEvidence });
    const system = (
      mockStream.mock.calls[0]![0] as { system: Array<{ text: string }> }
    ).system[0]!.text;
    expect(loadBusinessEvidence).toHaveBeenCalledWith({
      selectedAdAccount: { id: "act_123", currency: "USD" },
      sourceId: "source-1",
      signal: expect.any(AbortSignal),
    });
    expect(system).toContain("CANONICAL BUSINESS EVIDENCE:\nVerified sales: 3");

    scriptClaude(answer("Compared."));
    await turn({
      loadBusinessEvidence: async () => {
        throw new Error("Private merchant records");
      },
    });
    const second = (
      mockStream.mock.calls[1]![0] as { system: Array<{ text: string }> }
    ).system[0]!.text;
    expect(second).toContain("Unavailable for this request");
    expect(second).not.toContain("Private merchant records");
  });

  it("appends Claude's thinking blocks back unchanged on the next step", async () => {
    const first = calls(
      thinking("sig-opaque"),
      text("Let me check."),
      toolUse("tu_1", "ads_get_ad_accounts", {})
    );
    scriptClaude(first, answer("Done."));

    await turn();

    expect(request(1).messages[1]).toEqual({
      role: "assistant",
      content: first.content,
    });
    expect(request(1).messages[1]!.content).toBe(first.content);
  });

  it("exposes server-owned ids as Airi's, and asks writes for a review sentence", async () => {
    scriptClaude(answer("Hello."));

    await turn();

    const tools = request(0).tools;
    const report = tools.find(item => item.name === reportTool.name)!;
    expect(report.input_schema.properties).not.toHaveProperty(
      "client_conversation_id"
    );
    expect(report.input_schema.required).toEqual(["ad_account_id"]);
    expect(report.description).toMatch(/^\[READ\]/);
    const write = tools.find(item => item.name === "ads_create_campaign")!;
    expect(write.description).toMatch(/^\[WRITE/);
    expect(write.input_schema.required).toEqual(["airi_change_summary"]);
    expect(request(0).tool_choice).toEqual({ type: "auto" });
  });

  it("turns a write into a confirmation card and never executes it", async () => {
    scriptClaude(
      calls(
        toolUse("tu_1", "ads_create_campaign", {
          name: "Spring",
          airi_change_summary: "Create the paused Spring campaign",
        })
      ),
      answer("I prepared the Spring campaign for your review.")
    );

    const result = await turn({ userMessage: "Create a Spring campaign" });

    expect(callMetaAdsMcpTool).not.toHaveBeenCalled();
    expect(result.pendingMutations).toHaveLength(1);
    expect(result.pendingMutations[0]).toMatchObject({
      tool: { name: "ads_create_campaign" },
      logicalArguments: { name: "Spring" },
      summary: "Create the paused Spring campaign",
    });
    expect(result.pendingMutations[0]!.logicalArguments).not.toHaveProperty(
      "airi_change_summary"
    );
    expect(toolResults(1)[0]!.content).toMatch(/NOT executed/);
    expect(result.content).toContain(
      "I prepared the Spring campaign for your review."
    );
    expect(result.content).toMatch(/They have not run/);
    expect(result.toolTrace).toEqual([
      expect.objectContaining({
        name: "ads_create_campaign",
        status: "pending_confirmation",
      }),
    ]);
    expect(result.failureCode).toBeUndefined();
  });

  it("prepares one card for identical writes in one turn", async () => {
    const args = { name: "Spring", airi_change_summary: "Create Spring" };
    scriptClaude(
      calls(
        toolUse("tu_1", "ads_create_campaign", args),
        toolUse("tu_2", "ads_create_campaign", args)
      ),
      answer("Prepared.")
    );

    const result = await turn();

    expect(result.pendingMutations).toHaveLength(1);
    expect(toolResults(1)[1]!.content).toMatch(/already prepared/);
  });

  it("prepares at most three changes per turn and tells the model about the rest", async () => {
    const write = (index: number) =>
      toolUse(`tu_${index}`, "ads_create_campaign", {
        name: `Campaign ${index}`,
        airi_change_summary: `Create campaign ${index}`,
      });
    scriptClaude(
      calls(write(1), write(2)),
      calls(write(3), write(4), write(5)),
      answer("Three changes are ready; I can prepare the rest next.")
    );

    const result = await turn({ userMessage: "Create five campaigns" });

    expect(MAX_PREPARED_WRITES_PER_TURN).toBe(3);
    expect(result.pendingMutations).toHaveLength(3);
    const second = toolResults(2);
    expect(second[0]!.content).toMatch(/NOT executed/);
    for (const refused of second.slice(1)) {
      expect(refused).toMatchObject({ is_error: true });
      expect(refused.content).toMatch(/At most 3 changes/);
    }
    expect(result.content).toMatch(/Prepared 3 change\(s\)/);
    expect(callMetaAdsMcpTool).not.toHaveBeenCalled();
  });

  it("gives the model a prerequisite read's data when it asks for that read itself", async () => {
    // Airi verifies the account inventory before the report read.
    mockReadPrecondition
      .mockReturnValueOnce({
        kind: "prerequisite",
        call: {
          name: "ads_get_ad_accounts",
          arguments: {},
          summary: "Verify the ad accounts",
        },
      })
      .mockReturnValue({ kind: "ready" });
    (callMetaAdsMcpTool as jest.Mock).mockImplementation(
      async (params: { tool: MetaAdsMcpTool }) =>
        params.tool.name === "ads_get_ad_accounts"
          ? { data: [{ id: "act_123", name: "INVENTORY_MARKER" }] }
          : { data: [{ spend: "10" }] }
    );
    scriptClaude(
      calls(toolUse("tu_1", reportTool.name, { ad_account_id: "123" })),
      calls(toolUse("tu_2", "ads_get_ad_accounts", {})),
      calls(toolUse("tu_3", "ads_get_ad_accounts", {})),
      answer("You have one account.")
    );

    await turn();

    expect(toolResults(1)[0]!.content).not.toContain("INVENTORY_MARKER");
    // The read the model never saw comes back with its data, not a pointer.
    expect(toolResults(2)[0]!.content).toContain("INVENTORY_MARKER");
    expect(toolResults(2)[0]!.content).not.toMatch(/already succeeded/);
    // Once seen, a further repeat is only pointed back at it.
    expect(toolResults(3)[0]!.content).toMatch(/already succeeded/);
    expect(
      (callMetaAdsMcpTool as jest.Mock).mock.calls.filter(
        ([params]) => params.tool.name === "ads_get_ad_accounts"
      )
    ).toHaveLength(1);
  });

  it("counts error results against the shared result budget", async () => {
    const failure = new MetaAdsMcpToolResultError(
      reportTool.name,
      "Meta rejected the read",
      { error: { message: "x".repeat(3_000) } }
    );
    // Three full reads, then ten rejected ones with provider diagnostics.
    const read = (cursor: string) =>
      toolUse(`tu_${cursor}`, reportTool.name, {
        ad_account_id: "123",
        cursor,
      });
    scriptClaude(
      calls(
        ...["s0", "s1", "s2"].map(read),
        ...Array.from({ length: 10 }, (_, index) => read(`f${index}`))
      ),
      calls(toolUse("tu_last", "ads_get_ad_accounts", {})),
      answer("Done.")
    );
    (callMetaAdsMcpTool as jest.Mock).mockImplementation(
      async (params: {
        tool: MetaAdsMcpTool;
        arguments: { cursor?: string };
      }) => {
        if (params.tool.name === "ads_get_ad_accounts")
          return { data: "Ж".repeat(60_000) };
        if (params.arguments.cursor?.startsWith("f")) throw failure;
        return { data: "a".repeat(30_000) };
      }
    );

    await turn();

    const bytes = (value: string) =>
      Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
    const spent = toolResults(1).reduce(
      (total, result) => total + bytes(result.content),
      0
    );
    // The error results are what leaves less than one result's share.
    expect(100_000 - spent).toBeLessThan(24_000);
    const last = toolResults(2)[0]!.content;
    expect(last).toMatch(/Result truncated/);
    expect(bytes(last)).toBeLessThanOrEqual(Math.max(0, 100_000 - spent) + 300);
  });

  const earlierCard = (preparedAt: string) => ({
    threadId: THREAD_ID,
    messageId: "507f1f77bcf86cd799439010",
    transaction: prepareMetaAdsMcpTransaction({
      id: "earlier-card",
      preparedAt,
      target: {
        sourceId: "source-1",
        connectionId: "connection-1",
        mcpUserId: "mcp-user-1",
        adAccountId: "act_123",
        currency: "USD",
      },
      tool: {
        name: "ads_create_campaign",
        definitionSha256: DEFINITION_SHA256,
        catalogSha256: CATALOG_SHA256,
      },
      logicalArguments: { name: "Spring" },
      summary: "Create campaign",
      creativeAssets: [],
    }),
  });

  it("prepares a new card when the earlier identical card has expired", async () => {
    mockListPendingTransactions.mockResolvedValue([
      earlierCard(new Date(Date.now() - 46 * 60 * 1_000).toISOString()),
    ]);
    scriptClaude(
      calls(
        toolUse("tu_1", "ads_create_campaign", {
          name: "Spring",
          airi_change_summary: "Create Spring",
        })
      ),
      answer("Prepared again for review.")
    );

    const result = await turn({ threadId: THREAD_ID });

    expect(result.pendingMutations).toHaveLength(1);
    expect(result.content).not.toContain("already waiting");
  });

  it("ends as cancelled when the user stops the turn during a read", async () => {
    const controller = new AbortController();
    (callMetaAdsMcpTool as jest.Mock).mockImplementationOnce(async () => {
      controller.abort();
      return { ok: true };
    });
    scriptClaude(
      calls(toolUse("tu_1", "ads_get_ad_accounts", {})),
      answer("Should not be requested.")
    );

    const result = await turn({ signal: controller.signal });

    expect(result.failureCode).toBe("cancelled");
    expect(result.content).toContain("stopped before it finished");
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it("does not prepare a change that already awaits review in this thread", async () => {
    mockListPendingTransactions.mockResolvedValue([
      earlierCard(new Date().toISOString()),
    ]);
    scriptClaude(
      calls(
        toolUse("tu_1", "ads_create_campaign", {
          name: "Spring",
          airi_change_summary: "Create Spring",
        })
      ),
      answer("That change is already waiting for you.")
    );

    const result = await turn({ threadId: THREAD_ID });

    expect(result.pendingMutations).toEqual([]);
    expect(result.content).toContain("already waiting for your review");
    expect(result.failureCode).toBeUndefined();
  });

  it.each([
    ["skips the pending lookup without a thread", undefined],
    ["prepares the change when the pending lookup fails", THREAD_ID],
  ])("%s", async (_case, threadId) => {
    if (threadId) mockListPendingTransactions.mockRejectedValue(new Error());
    else
      mockListPendingTransactions.mockResolvedValue([
        earlierCard(new Date().toISOString()),
      ]);
    scriptClaude(
      calls(
        toolUse("tu_1", "ads_create_campaign", {
          name: "Spring",
          airi_change_summary: "Create Spring",
        })
      ),
      answer("Prepared.")
    );

    const result = await turn({ threadId });

    expect(mockListPendingTransactions).toHaveBeenCalledTimes(threadId ? 1 : 0);
    expect(result.pendingMutations).toHaveLength(1);
  });

  it("returns a schema error the model corrects on its next call", async () => {
    scriptClaude(
      calls(toolUse("tu_1", reportTool.name, { ad_account_id: 123 })),
      (req, index) => {
        expect(index).toBe(1);
        expect(toolResults(1)[0]).toMatchObject({
          is_error: true,
          content: expect.stringContaining("input schema"),
        });
        return calls(
          toolUse("tu_2", reportTool.name, { ad_account_id: "123" })
        );
      },
      answer("Spend was flat week over week.")
    );

    const result = await turn();

    expect(callMetaAdsMcpTool).toHaveBeenCalledTimes(1);
    expect(callMetaAdsMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: {
          ad_account_id: "123",
          client_conversation_id: expect.stringMatching(/^[A-Za-z0-9]{20}$/),
        },
      })
    );
    // The corrected read replaces the failure: an honest, complete report.
    expect(result.coverage).toMatchObject({
      complete: true,
      recovered: ["invalid_arguments"],
    });
    expect(result.failureCode).toBeUndefined();
    expect(result.content).toBe("Spend was flat week over week.");
  });

  it("returns a correctable precondition block as a tool error and recovers", async () => {
    mockReadPrecondition
      .mockReturnValueOnce({
        kind: "blocked",
        code: "unsupported_field",
        message: "Meta does not support one of the requested fields.",
      })
      .mockReturnValue({ kind: "ready" });
    scriptClaude(
      calls(toolUse("tu_1", reportTool.name, { ad_account_id: "123" })),
      calls(
        toolUse("tu_2", reportTool.name, {
          ad_account_id: "123",
          cursor: "x",
        })
      ),
      answer("Report ready.")
    );

    const result = await turn();

    expect(toolResults(1)[0]).toMatchObject({
      is_error: true,
      content: expect.stringContaining("unsupported_field"),
    });
    expect(result.coverage?.complete).toBe(true);
    expect(result.failureCode).toBeUndefined();
  });

  it("rejects ad accounts outside the verified workspace inventory", async () => {
    scriptClaude(
      calls(toolUse("tu_1", reportTool.name, { ad_account_id: "999" })),
      answer("I cannot read that account.")
    );

    const result = await turn();

    expect(callMetaAdsMcpTool).not.toHaveBeenCalled();
    expect(toolResults(1)[0]).toMatchObject({
      is_error: true,
      content: expect.stringContaining("act_123"),
    });
    expect(result.coverage?.complete).toBe(false);
    expect(result.content).toContain("Answered without live Meta Ads data");
  });

  it("hands provider errors back as bounded, untrusted diagnostics", async () => {
    (callMetaAdsMcpTool as jest.Mock).mockRejectedValueOnce(
      new MetaAdsMcpToolResultError("ads_get_ad_accounts", "bad", {
        isError: true,
        content: [{ type: "text", text: "Unknown field foo" }],
      })
    );
    scriptClaude(
      calls(toolUse("tu_1", "ads_get_ad_accounts", { fields: ["foo"] })),
      calls(toolUse("tu_2", "ads_get_ad_accounts", {})),
      answer("Accounts listed.")
    );

    const result = await turn();

    expect(toolResults(1)[0]).toMatchObject({
      is_error: true,
      content: expect.stringContaining("untrusted data"),
    });
    expect(toolResults(1)[0]!.content).toContain("Unknown field foo");
    expect(result.coverage?.complete).toBe(true);
    expect(result.failureCode).toBeUndefined();
  });

  it("reads further pages of the same query inside one tool call", async () => {
    (callMetaAdsMcpTool as jest.Mock)
      .mockResolvedValueOnce({ data: [{ id: "1" }], next_cursor: "page-2" })
      .mockResolvedValueOnce({ data: [{ id: "2" }] });
    scriptClaude(
      calls(toolUse("tu_1", reportTool.name, { ad_account_id: "123" })),
      answer("Two rows.")
    );

    const result = await turn();

    expect(callMetaAdsMcpTool).toHaveBeenCalledTimes(2);
    expect(
      (callMetaAdsMcpTool as jest.Mock).mock.calls[1][0].arguments
    ).toMatchObject({ cursor: "page-2" });
    expect(JSON.parse(toolResults(1)[0]!.content)).toEqual({
      pages: [
        { data: [{ id: "1" }], next_cursor: "page-2" },
        { data: [{ id: "2" }] },
      ],
    });
    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(result.coverage).toMatchObject({ complete: true, pendingPages: 0 });
  });

  it("bounds the loop: the last step withholds tools and the report is partial", async () => {
    let step = 0;
    scriptClaude(req =>
      req.tool_choice.type === "none"
        ? answer("Here is what I found so far.")
        : calls(toolUse(`tu_${++step}`, "ads_get_ad_accounts", { step }))
    );

    const result = await turn();

    expect(mockStream).toHaveBeenCalledTimes(10);
    expect(request(9).tool_choice).toEqual({ type: "none" });
    expect(callMetaAdsMcpTool).toHaveBeenCalledTimes(9);
    expect(result.failureCode).toBe("execution_budget_exhausted");
    expect(result.coverage?.reasons).toContain("execution_budget_exhausted");
    expect(result.content).toContain("Here is what I found so far.");
    expect(result.content).toContain("**Partial report:**");
  });

  it("stops collecting near the deadline and answers from the evidence", async () => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const nowSpy = jest
      .spyOn(Date, "now")
      .mockImplementation(() => realNow() + offset);
    try {
      (callMetaAdsMcpTool as jest.Mock).mockImplementationOnce(async () => {
        offset = 170_000;
        return { ok: true };
      });
      scriptClaude(
        calls(toolUse("tu_1", "ads_get_ad_accounts", {})),
        answer("Partial answer from one read.")
      );

      const result = await turn();

      expect(request(1).tool_choice).toEqual({ type: "none" });
      expect(result.failureCode).toBe("collection_deadline_exceeded");
      expect(result.coverage?.complete).toBe(false);
      expect(result.content).toContain("Partial answer from one read.");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("streams the answer text to the caller", async () => {
    scriptClaude(
      calls(toolUse("tu_1", "ads_get_ad_accounts", {})),
      answer("One account is active.")
    );
    const streamed: string[] = [];

    const result = await turn({
      onTextDelta: value => void streamed.push(value),
    });

    expect(streamed.at(-1)).toBe("One account is active.");
    expect(streamed.length).toBeGreaterThan(1);
    expect(
      streamed.every(value => "One account is active.".startsWith(value))
    ).toBe(true);
    expect(result.content).toBe("One account is active.");
  });

  it("labels an answer that read no account data", async () => {
    scriptClaude(
      answer("A lookalike audience is built from a source audience.")
    );

    const result = await turn({ userMessage: "What is a lookalike audience?" });

    expect(callMetaAdsMcpTool).not.toHaveBeenCalled();
    expect(result.content).toContain("Answered without live Meta Ads data");
    expect(result.failureCode).toBeUndefined();
    expect(result.coverage).toBeUndefined();
  });

  describe("Claude only (fails closed)", () => {
    it("fails closed before touching Meta when Claude is not configured", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      const supabase = readySupabase();

      const result = await turn({
        supabase: supabase as never,
        userMessage: "Покажи расходы по кампаниям",
      });

      expect(result.failureCode).toBe("meta_ads_requires_claude");
      expect(result.content).toBe(
        getMetaAdsRequiresClaudeMessage("ru", "not_configured")
      );
      expect(supabase.from).not.toHaveBeenCalled();
      expect(createMetaAdsMcpSession).not.toHaveBeenCalled();
      expect(mockStream).not.toHaveBeenCalled();
      expect(chatCompletionWithFallback).not.toHaveBeenCalled();
    });

    it("fails closed in the workspace language when the workspace pays with its own Google key", async () => {
      mockResolveBilling.mockResolvedValue({
        billingSource: "customer",
        workspaceId: "workspace-1",
      });

      const result = await turn({ language: "kz" });

      expect(result.failureCode).toBe("meta_ads_requires_claude");
      expect(result.content).toBe(
        getMetaAdsRequiresClaudeMessage("kz", "customer_billing")
      );
      expect(mockStream).not.toHaveBeenCalled();
    });

    it("keeps verified evidence when Claude fails mid-turn, with no Gemini fallback", async () => {
      const overloaded = () =>
        new InternalServerError(
          529,
          { type: "overloaded_error" },
          "Overloaded",
          new Headers()
        );
      (callMetaAdsMcpTool as jest.Mock).mockResolvedValueOnce({
        ad_accounts: [{ id: "act_123", name: "Main", currency: "USD" }],
      });
      scriptClaude(
        calls(toolUse("tu_1", "ads_get_ad_accounts", {})),
        overloaded(),
        overloaded()
      );

      const result = await turn();

      expect(result.failureCode).toBe("meta_ads_requires_claude");
      expect(result.content).toContain(
        getMetaAdsRequiresClaudeMessage("en", "provider_failed")
      );
      expect(result.content).toContain("Main");
      expect(result.coverage?.complete).toBe(false);
      expect(chatCompletionWithFallback).not.toHaveBeenCalled();
    });
  });

  it("explains a Meta rollout block before starting Claude", async () => {
    const result = await turn({
      supabase: readySupabase(false) as never,
    });

    expect(result.failureCode).toBe("asset_unavailable");
    expect(mockStream).not.toHaveBeenCalled();
  });

  describe("probe session, account seed and cache cancellation", () => {
    const entityTools = () =>
      createCatalog([
        createTool("ads_get_ad_entities"),
        createTool("ads_get_ad_accounts"),
        createTool("ads_get_field_context"),
      ]);
    const accountRow = {
      ad_account_id: "123",
      is_ads_mcp_enabled: true,
      is_queryable: true,
    };
    const entityRead = (args: Record<string, unknown> = {}) =>
      calls(
        toolUse("tu_1", "ads_get_ad_entities", {
          ad_account_id: "123",
          level: "campaign",
          ...args,
        })
      );
    const toolNames = () =>
      (callMetaAdsMcpTool as jest.Mock).mock.calls.map(
        ([call]) => call.tool.name
      );

    beforeEach(() => {
      mockReadPrecondition.mockImplementation(
        jest.requireActual("./preconditions").getMetaAdsMcpReadPrecondition
      );
      (listMetaAdsMcpTools as jest.Mock).mockResolvedValue(entityTools());
      (callMetaAdsMcpTool as jest.Mock).mockImplementation(
        async ({ tool }: { tool: MetaAdsMcpTool }) =>
          tool.name === "ads_get_ad_accounts"
            ? { ad_accounts: [accountRow] }
            : tool.name === "ads_get_field_context"
              ? {
                  fields: [
                    {
                      name: "clicks",
                      levels: ["campaign"],
                      filterable: false,
                      sortable: true,
                      supported_filter_operators: [],
                    },
                  ],
                }
              : { ad_entities: [{ name: "Spring", clicks: 4 }] }
      );
    });

    it("reuses the session, catalog and account inventory of a probe this request ran", async () => {
      const liveSession = { accessToken: "mcp-token", probe: true };
      mockResolveAccess.mockImplementationOnce(async input => ({
        ...(await jest
          .requireActual("./readiness-service")
          .resolveWorkspaceMetaAdsMcpAccessToken(input)),
        liveSession: {
          session: liveSession,
          catalog: entityTools(),
          accountInventory: { ad_accounts: [accountRow] },
        },
      }));
      scriptClaude(
        entityRead({ fields: ["clicks"] }),
        answer("Spring had 4 clicks.")
      );

      const result = await turn({ userMessage: "campaign clicks" });

      expect(mockResolveAccess).toHaveBeenCalledWith(
        expect.objectContaining({ retainProbeSession: true })
      );
      expect(createMetaAdsMcpSession).not.toHaveBeenCalled();
      expect(initializeMetaAdsMcpSession).not.toHaveBeenCalled();
      expect(listMetaAdsMcpTools).not.toHaveBeenCalled();
      // The probe's inventory replaces the ads_get_ad_accounts prerequisite.
      expect(toolNames()).toEqual([
        "ads_get_field_context",
        "ads_get_ad_entities",
      ]);
      for (const [call] of (callMetaAdsMcpTool as jest.Mock).mock.calls)
        expect(call.session).toBe(liveSession);
      expect(closeMetaAdsMcpSession).toHaveBeenCalledWith(liveSession);
      expect(result.coverage?.complete).toBe(true);
    });

    it("closes a handed-over session when the connection cannot read", async () => {
      const liveSession = { accessToken: "mcp-token", probe: true };
      mockResolveAccess.mockImplementationOnce(async input => {
        const access = await jest
          .requireActual("./readiness-service")
          .resolveWorkspaceMetaAdsMcpAccessToken(input);
        return {
          ...access,
          readiness: { ...access.readiness, canRead: false },
          liveSession: { session: liveSession, catalog: entityTools() },
        };
      });

      await turn({ userMessage: "campaign clicks" });

      expect(closeMetaAdsMcpSession).toHaveBeenCalledWith(liveSession);
      expect(mockStream).not.toHaveBeenCalled();
    });

    it("closes a probe session that arrives after the turn was cancelled", async () => {
      const controller = new AbortController();
      const liveSession = { probe: true };
      let finishAuthorization: (value: unknown) => void = () => undefined;
      mockResolveAccess.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishAuthorization = resolve;
          })
      );

      const running = turn({
        userMessage: "campaign clicks",
        signal: controller.signal,
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(mockResolveAccess).toHaveBeenCalledTimes(1);
      controller.abort();
      const result = await running;

      expect(result.failureCode).toBe("cancelled");
      finishAuthorization({
        liveSession: { session: liveSession, catalog: entityTools() },
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(closeMetaAdsMcpSession).toHaveBeenCalledWith(liveSession);
    });

    it("seeds the selected account's availability from fresh readiness evidence", async () => {
      scriptClaude(entityRead(), answer("Spring is live."));

      const result = await turn({
        supabase: readySupabase(true, true) as never,
        userMessage: "list campaigns",
      });

      // No ads_get_ad_accounts prerequisite: the stored probe vouches for it.
      expect(toolNames()).toEqual(["ads_get_ad_entities"]);
      expect(result.coverage?.complete).toBe(true);
    });

    it("still ends the turn as cancelled when the user cancels during the cache lookup", async () => {
      const controller = new AbortController();
      (cache.get as jest.Mock).mockImplementationOnce(() => {
        setTimeout(() => controller.abort(), 10);
        return new Promise(() => undefined);
      });
      scriptClaude(
        entityRead({ fields: ["clicks"] }),
        answer("Should not be requested.")
      );

      const result = await turn({
        userMessage: "campaign clicks",
        signal: controller.signal,
      });

      expect(result.failureCode).toBe("cancelled");
      expect(cache.get).toHaveBeenCalledWith(
        expect.stringContaining("meta_ads_mcp_field_context")
      );
      expect(toolNames()).toEqual(["ads_get_ad_accounts"]);
      expect(mockStream).toHaveBeenCalledTimes(1);
    });
  });
});

describe("resolveMetaAdsNoticeLanguage", () => {
  it.each([
    ["kz", "anything", "kz"],
    ["ru", "anything", "ru"],
    ["uz", "Salom", "en"],
    [undefined, "Қанша жұмсадық?", "kz"],
    [undefined, "Сколько потратили?", "ru"],
    [undefined, "How much did we spend?", "en"],
  ] as const)("%s / %s -> %s", (language, message, expected) => {
    expect(resolveMetaAdsNoticeLanguage(language, message)).toBe(expected);
  });
});

describe("field metadata cache", () => {
  const fieldTool = createTool("ads_get_field_context");
  const key = (connectionId: string) =>
    fieldContextCacheKey({
      auth: {
        sourceId: "source-1",
        credentials: { mcp_connection_id: connectionId },
      } as never,
      tool: fieldTool,
      args: { level: "campaign" },
    });

  it("does not share field metadata across Meta connections", () => {
    expect(key("connection-1")).toContain("meta_ads_mcp_field_context");
    expect(key("connection-1")).not.toBe(key("connection-2"));
  });

  it("reuses recently verified field metadata", async () => {
    (cache.get as jest.Mock).mockResolvedValueOnce({ fields: [] });
    await expect(
      readCachedFieldContext("key", new AbortController().signal)
    ).resolves.toEqual({ fields: [] });
  });

  it("treats a cache lookup that never answers as a miss", async () => {
    // A slow or unreachable cache (Upstash retries with backoff) must not
    // hold the turn: after a short bound the live read runs instead.
    (cache.get as jest.Mock).mockImplementationOnce(
      () => new Promise(() => undefined)
    );
    const startedAt = Date.now();
    await expect(
      readCachedFieldContext("key", new AbortController().signal)
    ).resolves.toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
