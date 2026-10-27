const mockClientListTools = jest.fn();
const mockClientCallTool = jest.fn();
const mockClientConnect = jest.fn();
const mockClientClose = jest.fn();
const mockTerminateSession = jest.fn();

jest.mock("@modelcontextprotocol/client", () => {
  class BrandedError extends Error {
    static isInstance(): boolean {
      return false;
    }
  }

  class HttpError extends Error {
    readonly status: number;
    constructor(_code: string, message: string, data: { status: number }) {
      super(message);
      this.status = data.status;
    }
    static isInstance(value: unknown): boolean {
      return value instanceof HttpError;
    }
  }

  class Client {
    async connect(): Promise<void> {
      await mockClientConnect();
    }

    getProtocolEra(): "legacy" {
      return "legacy";
    }

    getNegotiatedProtocolVersion(): string {
      return "2025-06-18";
    }

    getServerVersion(): { name: string; version: string } {
      return { name: "meta-ads-mcp-test", version: "1.0.0" };
    }

    getServerCapabilities(): { tools: Record<string, never> } {
      return { tools: {} };
    }

    listTools(...args: unknown[]): Promise<unknown> {
      return mockClientListTools(...args);
    }

    callTool(...args: unknown[]): Promise<unknown> {
      return mockClientCallTool(...args);
    }

    async close(): Promise<void> {
      await mockClientClose();
    }
  }

  class StreamableHTTPClientTransport {
    async terminateSession(): Promise<void> {
      await mockTerminateSession();
    }

    setProtocolVersion(): void {}
  }

  return {
    Client,
    StreamableHTTPClientTransport,
    InsufficientScopeError: BrandedError,
    ProtocolError: BrandedError,
    SdkError: BrandedError,
    SdkErrorCode: {
      RequestTimeout: "request_timeout",
      ConnectionClosed: "connection_closed",
      NotConnected: "not_connected",
      ClientHttpFailedToOpenStream: "failed_to_open_stream",
    },
    SdkHttpError: HttpError,
    UnauthorizedError: BrandedError,
  };
});

import { SdkHttpError, SdkErrorCode } from "@modelcontextprotocol/client";

import {
  callMetaAdsMcpTool,
  createMetaAdsMcpSession,
  initializeMetaAdsMcpSession,
  listMetaAdsMcpTools,
  MetaAdsMcpClientError,
  MetaAdsMcpToolResultError,
} from "./client";

describe("listMetaAdsMcpTools", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("projects the complete SDK catalog and preserves every tool input schema", async () => {
    const tools = Array.from({ length: 91 }, (_, index) => ({
      name: `ads_get_report_${index + 1}`,
      description: `Report ${index + 1}`,
      inputSchema: {
        type: "object",
        properties: { account_id: { type: "string" } },
        required: ["account_id"],
      },
    }));
    mockClientListTools.mockResolvedValue({ tools });
    const session = createMetaAdsMcpSession("mcp-token");
    await initializeMetaAdsMcpSession(session);

    const catalog = await listMetaAdsMcpTools(session);

    expect(catalog.tools).toHaveLength(91);
    expect(
      catalog.tools.find(tool => tool.name === "ads_get_report_91")
    ).toEqual(
      expect.objectContaining({
        name: "ads_get_report_91",
        inputSchema: expect.objectContaining({ type: "object" }),
        definitionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
    );
    expect(catalog.catalogSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(catalog.protocol).toEqual(
      expect.objectContaining({
        era: "legacy",
        protocolVersion: "2025-06-18",
      })
    );
    expect(mockClientListTools).toHaveBeenCalledTimes(1);
  });

  it("preserves long provider workflow requirements without cutting the description", async () => {
    const description = `${"campaign field documentation ".repeat(1000)}\nFirst verify the requested fields with ads_get_field_context.\n`;
    mockClientListTools.mockResolvedValue({
      tools: [
        {
          name: "ads_get_ad_entities",
          description,
          inputSchema: { type: "object" },
        },
      ],
    });
    const session = createMetaAdsMcpSession("mcp-token");
    await initializeMetaAdsMcpSession(session);
    const catalog = await listMetaAdsMcpTools(session);
    expect(catalog.tools[0].description).toBe(description);
  });

  it("rejects an oversized provider description instead of silently removing its contract", async () => {
    mockClientListTools.mockResolvedValue({
      tools: [
        {
          name: "ads_get_ad_entities",
          description: "x".repeat(64_001),
          inputSchema: { type: "object" },
        },
      ],
    });
    const session = createMetaAdsMcpSession("mcp-token");
    await initializeMetaAdsMcpSession(session);
    await expect(listMetaAdsMcpTools(session)).rejects.toMatchObject({
      code: "invalid_catalog",
    });
  });

  it("accepts a provider-shaped catalog beyond the default canonical member budget", async () => {
    mockClientListTools.mockResolvedValue({
      tools: Array.from({ length: 30 }, (_, toolIndex) => ({
        name: `ads_report_${toolIndex}`,
        inputSchema: {
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: 200 }, (_, fieldIndex) => [
              `field_${fieldIndex}`,
              { type: "string", description: "Provider field contract" },
            ])
          ),
        },
      })),
    });
    const session = createMetaAdsMcpSession("mcp-token");
    await initializeMetaAdsMcpSession(session);

    const catalog = await listMetaAdsMcpTools(session);

    expect(catalog.tools).toHaveLength(30);
    expect(
      Object.keys(catalog.tools[29]!.inputSchema.properties as object)
    ).toHaveLength(200);
  });

  it("uses the catalog byte budget for complete provider descriptions beyond one megabyte", async () => {
    const description = "Contract ".repeat(4_000);
    mockClientListTools.mockResolvedValue({
      tools: Array.from({ length: 30 }, (_, index) => ({
        name: `ads_report_${index}`,
        description,
        inputSchema: { type: "object" },
      })),
    });
    const session = createMetaAdsMcpSession("mcp-token");
    await initializeMetaAdsMcpSession(session);

    const catalog = await listMetaAdsMcpTools(session);

    expect(catalog.canonicalSizeBytes).toBeGreaterThan(1_000_000);
    expect(catalog.tools[29]!.description).toBe(description);
  });

  it("rejects a catalog exceeding its explicit total byte budget", async () => {
    mockClientListTools.mockResolvedValue({
      tools: Array.from({ length: 132 }, (_, index) => ({
        name: `ads_report_${index}`,
        description: "x".repeat(64_000),
        inputSchema: { type: "object" },
      })),
    });
    const session = createMetaAdsMcpSession("mcp-token");
    await initializeMetaAdsMcpSession(session);
    await expect(listMetaAdsMcpTools(session)).rejects.toMatchObject({
      code: "invalid_catalog",
    });
  });

  it("calls an optional-task tool normally while excluding required-task tools", async () => {
    const optionalTool = {
      name: "ads_get_ad_accounts",
      inputSchema: { type: "object" },
      execution: { taskSupport: "optional" },
    };
    mockClientListTools.mockResolvedValue({
      tools: [
        optionalTool,
        {
          name: "ads_long_running_campaign",
          inputSchema: { type: "object" },
          execution: { taskSupport: "required" },
        },
      ],
    });
    mockClientCallTool.mockResolvedValue({ content: [] });
    const session = createMetaAdsMcpSession("mcp-token");
    await initializeMetaAdsMcpSession(session);

    const catalog = await listMetaAdsMcpTools(session);
    expect(catalog.tools.map(tool => tool.name)).toEqual([
      "ads_get_ad_accounts",
    ]);
    expect(catalog.unsupportedTaskToolCount).toBe(1);
    await expect(
      callMetaAdsMcpTool({
        session,
        tool: catalog.tools[0]!,
        sideEffect: "read",
      })
    ).resolves.toEqual({ content: [] });
    expect(mockClientCallTool).toHaveBeenCalledWith(
      { name: "ads_get_ad_accounts", arguments: {} },
      expect.objectContaining({ toolDefinition: optionalTool })
    );
    await expect(
      callMetaAdsMcpTool({
        session,
        tool: {
          name: "ads_long_running_campaign",
          inputSchema: { type: "object" },
          definitionSha256: "a".repeat(64),
        },
        sideEffect: "write",
      })
    ).rejects.toMatchObject({ code: "invalid_catalog" });
    expect(mockClientCallTool).toHaveBeenCalledTimes(1);
  });

  it("rejects a catalog with no callable tools after required-task exclusion", async () => {
    mockClientListTools.mockResolvedValue({
      tools: [
        {
          name: "ads_long_running_campaign",
          inputSchema: { type: "object" },
          execution: { taskSupport: "required" },
        },
      ],
    });
    const session = createMetaAdsMcpSession("mcp-token");
    await initializeMetaAdsMcpSession(session);
    await expect(listMetaAdsMcpTools(session)).rejects.toMatchObject({
      code: "invalid_catalog",
    });
  });

  it("rejects duplicate names even when one definition requires unsupported tasks", async () => {
    mockClientListTools.mockResolvedValue({
      tools: [
        {
          name: "ads_get_ad_accounts",
          inputSchema: { type: "object" },
        },
        {
          name: "ads_get_ad_accounts",
          inputSchema: { type: "object" },
          execution: { taskSupport: "required" },
        },
      ],
    });
    const session = createMetaAdsMcpSession("mcp-token");
    await initializeMetaAdsMcpSession(session);
    await expect(listMetaAdsMcpTools(session)).rejects.toMatchObject({
      code: "invalid_catalog",
    });
  });
});

describe("bounded read recovery and cancellation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClientCallTool.mockReset();
    mockClientListTools.mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function prepare(name = "ads_get_ad_accounts") {
    const exact = { name, inputSchema: { type: "object" } };
    mockClientListTools.mockResolvedValue({ tools: [exact] });
    const session = createMetaAdsMcpSession("private-token");
    await initializeMetaAdsMcpSession(session);
    const catalog = await listMetaAdsMcpTools(session);
    return { session, tool: catalog.tools[0]! };
  }

  it.each([429, 502, 503, 504])(
    "retries a reviewed read once on HTTP %i within the same deadline",
    async status => {
      const prepared = await prepare();
      const onRetry = jest.fn();
      mockClientCallTool
        .mockRejectedValueOnce(
          new SdkHttpError(
            SdkErrorCode.ClientHttpFailedToOpenStream,
            "temporary",
            { status }
          )
        )
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "accounts" }],
        });
      const pending = callMetaAdsMcpTool({
        ...prepared,
        sideEffect: "read",
        onRetry,
      });
      const assertion = expect(pending).resolves.toEqual({
        content: [{ type: "text", text: "accounts" }],
      });
      await jest.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(mockClientCallTool).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenCalledWith(
        expect.objectContaining({ attempt: 2, code: "transport_error", status })
      );
      const first = mockClientCallTool.mock.calls[0][1];
      const second = mockClientCallTool.mock.calls[1][1];
      expect(second.signal).toBe(first.signal);
      expect(second.timeout).toBeLessThan(first.timeout);
    }
  );

  it("never retries a mutation after dispatch", async () => {
    const prepared = await prepare("ads_create_campaign");
    const onDispatch = jest.fn();
    mockClientCallTool.mockRejectedValue(
      new MetaAdsMcpClientError("transport_error", "temporary", { status: 503 })
    );
    await expect(
      callMetaAdsMcpTool({ ...prepared, sideEffect: "write", onDispatch })
    ).rejects.toMatchObject({ code: "transport_error" });
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockClientCallTool).toHaveBeenCalledTimes(1);
    expect(onDispatch).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 404, 422])("does not retry HTTP %i", async status => {
    const prepared = await prepare();
    mockClientCallTool.mockRejectedValue(
      new SdkHttpError(SdkErrorCode.ClientHttpFailedToOpenStream, "permanent", {
        status,
      })
    );
    await expect(
      callMetaAdsMcpTool({ ...prepared, sideEffect: "read" })
    ).rejects.toMatchObject({ status });
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockClientCallTool).toHaveBeenCalledTimes(1);
  });

  it("rebuilds a reviewed read on a known fetch network cause", async () => {
    const prepared = await prepare();
    const error = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNRESET" },
    });
    mockClientCallTool
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ content: [] });
    const assertion = expect(
      callMetaAdsMcpTool({ ...prepared, sideEffect: "read" })
    ).resolves.toEqual({ content: [] });
    await jest.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(mockClientCallTool).toHaveBeenCalledTimes(2);
    expect(mockClientConnect).toHaveBeenCalledTimes(2);
  });

  it("honors cancellation even when an initialized session is reused", async () => {
    const prepared = await prepare();
    const controller = new AbortController();
    controller.abort();
    await expect(
      initializeMetaAdsMcpSession(prepared.session, {
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: "request_cancelled" });
    expect(mockClientConnect).toHaveBeenCalledTimes(1);
  });

  it("never retries an unreviewed name even when a caller labels it read-only", async () => {
    const prepared = await prepare("ads_new_tool");
    mockClientCallTool.mockRejectedValue(
      new MetaAdsMcpClientError("transport_error", "temporary", { status: 503 })
    );
    await expect(
      callMetaAdsMcpTool({ ...prepared, sideEffect: "read" })
    ).rejects.toMatchObject({ code: "transport_error" });
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockClientCallTool).toHaveBeenCalledTimes(1);
  });

  it.each([
    "provider_unauthorized",
    "insufficient_scope",
    "protocol_error",
    "invalid_catalog",
    "request_timeout",
  ] as const)("does not replay %s failures", async code => {
    const prepared = await prepare();
    mockClientCallTool.mockRejectedValue(
      new MetaAdsMcpClientError(code, "failed")
    );
    await expect(
      callMetaAdsMcpTool({ ...prepared, sideEffect: "read" })
    ).rejects.toMatchObject({ code });
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockClientCallTool).toHaveBeenCalledTimes(1);
  });

  it("does not replay tool-result errors or unknown local failures", async () => {
    const prepared = await prepare();
    mockClientCallTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "invalid input" }],
    });
    await expect(
      callMetaAdsMcpTool({ ...prepared, sideEffect: "read" })
    ).rejects.toBeInstanceOf(MetaAdsMcpToolResultError);
    mockClientCallTool.mockRejectedValueOnce(
      new TypeError("local programming error")
    );
    await expect(
      callMetaAdsMcpTool({ ...prepared, sideEffect: "read" })
    ).rejects.toMatchObject({ code: "transport_error" });
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockClientCallTool).toHaveBeenCalledTimes(2);
  });

  it("stops after the second transport failure", async () => {
    const prepared = await prepare();
    mockClientCallTool.mockRejectedValue(
      new MetaAdsMcpClientError("transport_error", "temporary", { status: 503 })
    );
    const assertion = expect(
      callMetaAdsMcpTool({ ...prepared, sideEffect: "read" })
    ).rejects.toMatchObject({ status: 503 });
    await jest.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(mockClientCallTool).toHaveBeenCalledTimes(2);
  });

  it("rebuilds a closed read session and verifies the current tool before retrying", async () => {
    const prepared = await prepare();
    mockClientCallTool
      .mockRejectedValueOnce(
        new MetaAdsMcpClientError("connection_closed", "closed")
      )
      .mockResolvedValueOnce({ content: [] });
    const assertion = expect(
      callMetaAdsMcpTool({ ...prepared, sideEffect: "read" })
    ).resolves.toEqual({ content: [] });
    await jest.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(mockClientConnect).toHaveBeenCalledTimes(2);
    expect(mockClientListTools).toHaveBeenCalledTimes(2);
    expect(mockClientClose).toHaveBeenCalledTimes(1);
    expect(mockTerminateSession).toHaveBeenCalledTimes(1);
  });

  it("does not replay a read when the refreshed tool contract has changed", async () => {
    const prepared = await prepare();
    mockClientCallTool.mockRejectedValueOnce(
      new MetaAdsMcpClientError("connection_closed", "closed")
    );
    mockClientListTools.mockResolvedValueOnce({
      tools: [
        {
          name: prepared.tool.name,
          inputSchema: { type: "object", required: ["new_field"] },
        },
      ],
    });
    const assertion = expect(
      callMetaAdsMcpTool({ ...prepared, sideEffect: "read" })
    ).rejects.toMatchObject({ code: "invalid_catalog" });
    await jest.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(mockClientCallTool).toHaveBeenCalledTimes(1);
  });

  it("honors caller cancellation before mutation dispatch", async () => {
    const prepared = await prepare("ads_create_campaign");
    const controller = new AbortController();
    controller.abort();
    const onDispatch = jest.fn();
    await expect(
      callMetaAdsMcpTool({
        ...prepared,
        sideEffect: "write",
        signal: controller.signal,
        onDispatch,
      })
    ).rejects.toMatchObject({ code: "request_cancelled" });
    expect(mockClientCallTool).not.toHaveBeenCalled();
    expect(onDispatch).not.toHaveBeenCalled();
  });

  it("cancels the backoff without a second dispatch", async () => {
    const prepared = await prepare();
    const controller = new AbortController();
    mockClientCallTool.mockRejectedValueOnce(
      new MetaAdsMcpClientError("transport_error", "temporary", { status: 503 })
    );
    const pending = callMetaAdsMcpTool({
      ...prepared,
      sideEffect: "read",
      signal: controller.signal,
    });
    const assertion = expect(pending).rejects.toMatchObject({
      code: "request_cancelled",
    });
    await jest.advanceTimersByTimeAsync(1);
    controller.abort();
    await assertion;
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockClientCallTool).toHaveBeenCalledTimes(1);
  });

  it("preserves a shared caller timeout during backoff", async () => {
    const prepared = await prepare();
    const controller = new AbortController();
    mockClientCallTool.mockRejectedValueOnce(
      new MetaAdsMcpClientError("transport_error", "temporary", { status: 503 })
    );
    const assertion = expect(
      callMetaAdsMcpTool({
        ...prepared,
        sideEffect: "read",
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: "request_timeout" });
    await jest.advanceTimersByTimeAsync(1);
    controller.abort(new DOMException("Turn deadline reached", "TimeoutError"));
    await assertion;
    expect(mockClientCallTool).toHaveBeenCalledTimes(1);
  });
});

describe("callMetaAdsMcpTool", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("throws a typed error when the active MCP tool result reports isError", async () => {
    const exactTool = {
      name: "ads_create_campaign",
      inputSchema: {
        type: "object",
        properties: { account_id: { type: "string" } },
        required: ["account_id"],
      },
    };
    mockClientListTools.mockResolvedValue({ tools: [exactTool] });
    mockClientCallTool.mockResolvedValue({
      isError: true,
      content: [
        {
          type: "text",
          text: "Invalid ad account or missing ads_management permission",
        },
      ],
    });
    const session = createMetaAdsMcpSession("mcp-token");
    await initializeMetaAdsMcpSession(session);
    const catalog = await listMetaAdsMcpTools(session);
    const tool = catalog.tools[0];
    expect(tool).toBeDefined();
    const onDispatch = jest.fn();

    const error = await callMetaAdsMcpTool({
      session,
      tool: tool!,
      arguments: { account_id: "act_123" },
      sideEffect: "write",
      onDispatch,
    }).catch(reason => reason);

    expect(error).toEqual(
      expect.objectContaining({
        name: "MetaAdsMcpToolResultError",
        toolName: "ads_create_campaign",
        message: "Invalid ad account or missing ads_management permission",
      })
    );
    expect(error).toBeInstanceOf(MetaAdsMcpToolResultError);
    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(mockClientCallTool).toHaveBeenCalledWith(
      {
        name: "ads_create_campaign",
        arguments: { account_id: "act_123" },
      },
      expect.objectContaining({ toolDefinition: exactTool })
    );
  });
});
