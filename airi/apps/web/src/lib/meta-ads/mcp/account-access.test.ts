const mockCall = jest.fn();
jest.mock("./client", () => ({
  callMetaAdsMcpTool: (...args: unknown[]) => mockCall(...args),
}));
import { readMetaAdsMcpAccountAccess } from "./account-access";
import { getMetaAdsMcpAccountEligibility } from "./preconditions";
import type { MetaAdsMcpCatalog, MetaAdsMcpSession } from "./client";

const tool = {
  name: "ads_get_ad_accounts",
  inputSchema: {
    type: "object",
    properties: { cursor: { type: "string" } },
    additionalProperties: false,
  },
  definitionSha256: "a".repeat(64),
};
const catalog = { tools: [tool] } as unknown as MetaAdsMcpCatalog;
const session = {} as MetaAdsMcpSession;

describe("bounded Meta MCP account inventory", () => {
  beforeEach(() => mockCall.mockReset());
  it("reads cursor pages and normalizes JSON-string account envelopes", async () => {
    mockCall
      .mockResolvedValueOnce({
        structuredContent: {
          ad_accounts: JSON.stringify({
            data: [{ ad_account_id: "1", is_ads_mcp_enabled: true }],
            pagination: { next_cursor: "page2" },
          }),
        },
      })
      .mockResolvedValueOnce({
        structuredContent: {
          ad_accounts: [{ ad_account_id: "2", is_ads_mcp_enabled: false }],
        },
      });
    const result = await readMetaAdsMcpAccountAccess({ session, catalog });
    expect(result.complete).toBe(true);
    expect(mockCall.mock.calls[1][0]).toMatchObject({
      arguments: { cursor: "page2" },
      sideEffect: "read",
    });
    expect(
      getMetaAdsMcpAccountEligibility({
        inventory: result.inventory,
        accountIds: ["act_2"],
      })
    ).toMatchObject({ kind: "blocked", code: "account_not_enabled" });
  });
  it("fails closed on repeated cursors", async () => {
    mockCall.mockResolvedValue({
      structuredContent: { ad_accounts: [], next_cursor: "again" },
    });
    const result = await readMetaAdsMcpAccountAccess({ session, catalog });
    expect(result).toMatchObject({
      complete: false,
      reason: "pagination_loop",
    });
    expect(mockCall).toHaveBeenCalledTimes(2);
  });
  it("stops after ten pages with incomplete coverage", async () => {
    let page = 0;
    mockCall.mockImplementation(async () => ({
      structuredContent: { ad_accounts: [], next_cursor: String(++page) },
    }));
    const result = await readMetaAdsMcpAccountAccess({ session, catalog });
    expect(result).toMatchObject({
      complete: false,
      reason: "account_page_limit",
    });
    expect(mockCall).toHaveBeenCalledTimes(10);
  });
  it("does not improvise arguments when the account schema changed", async () => {
    const changed = {
      tools: [
        {
          ...tool,
          inputSchema: {
            type: "object",
            required: ["unknown"],
            properties: { unknown: { type: "string" } },
          },
        },
      ],
    } as unknown as MetaAdsMcpCatalog;
    expect(
      await readMetaAdsMcpAccountAccess({ session, catalog: changed })
    ).toMatchObject({ complete: false, reason: "account_schema_changed" });
    expect(mockCall).not.toHaveBeenCalled();
  });
  it("propagates cancellation before any provider call", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      readMetaAdsMcpAccountAccess({
        session,
        catalog,
        signal: controller.signal,
      })
    ).rejects.toThrow("cancelled");
    expect(mockCall).not.toHaveBeenCalled();
  });
});

const conversationCatalog = {
  tools: [
    {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...tool.inputSchema.properties,
          client_conversation_id: {
            type: "string",
            pattern: "^[A-Za-z0-9]{20}$",
          },
        },
        required: ["client_conversation_id"],
      },
    },
  ],
} as unknown as MetaAdsMcpCatalog;

test("does not call Meta when account discovery is absent", async () => {
  mockCall.mockReset();
  expect(
    await readMetaAdsMcpAccountAccess({
      session,
      catalog: { tools: [] } as unknown as MetaAdsMcpCatalog,
    })
  ).toMatchObject({ complete: false, reason: "account_tool_unavailable" });
  expect(mockCall).not.toHaveBeenCalled();
});

test.each([undefined, "ServerConversation01"])(
  "uses one server conversation identity across inventory pages: %s",
  async clientConversationId => {
    mockCall
      .mockReset()
      .mockResolvedValueOnce({
        structuredContent: { ad_accounts: [], next_cursor: "page2" },
      })
      .mockResolvedValueOnce({ structuredContent: { ad_accounts: [] } });
    const result = await readMetaAdsMcpAccountAccess({
      session,
      catalog: conversationCatalog,
      clientConversationId,
    });
    expect(result.complete).toBe(true);
    const first = mockCall.mock.calls[0][0].arguments.client_conversation_id;
    expect(first).toMatch(/^[A-Za-z0-9]{20}$/);
    if (clientConversationId) expect(first).toBe(clientConversationId);
    expect(mockCall.mock.calls[1][0].arguments).toEqual({
      client_conversation_id: first,
      cursor: "page2",
    });
  }
);

test("the shared inventory deadline aborts an in-flight later page", async () => {
  jest.useFakeTimers();
  const deadline = jest.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException("Deadline", "TimeoutError")),
      ms
    );
    return controller.signal;
  });
  let secondSignal: AbortSignal | undefined;
  mockCall
    .mockReset()
    .mockResolvedValueOnce({
      structuredContent: { ad_accounts: [], next_cursor: "page2" },
    })
    .mockImplementationOnce(({ signal }: { signal: AbortSignal }) => {
      secondSignal = signal;
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        })
      );
    });
  try {
    const pending = expect(
      readMetaAdsMcpAccountAccess({ session, catalog })
    ).rejects.toMatchObject({ name: "TimeoutError" });
    await jest.advanceTimersByTimeAsync(0);
    expect(secondSignal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(20_000);
    await pending;
    expect(deadline).toHaveBeenCalledWith(20_000);
    expect(secondSignal?.aborted).toBe(true);
    expect(mockCall).toHaveBeenCalledTimes(2);
  } finally {
    deadline.mockRestore();
    jest.useRealTimers();
  }
});
