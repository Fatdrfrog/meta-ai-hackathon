const mockGetRealtimeGatewayUrl = jest.fn();

jest.mock("@/lib/realtime/gateway-url", () => ({
  getRealtimeGatewayUrl: () => mockGetRealtimeGatewayUrl(),
}));

describe("collectDependencyHealth", () => {
  const originalEnv = process.env;
  const mockFetch = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      UPSTASH_REDIS_REST_URL: "",
      UPSTASH_REDIS_REST_TOKEN: "",
      TELEGRAM_BOT_TOKEN: "",
      META_APP_ID: "",
      NEXT_PUBLIC_META_APP_ID: "",
      META_APP_SECRET: "",
    };
    mockGetRealtimeGatewayUrl.mockReturnValue("https://realtime.example.com");
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ runtimeMode: "realtimeGateway" }), {
        status: 200,
      })
    );
    global.fetch = mockFetch;
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("probes the realtime gateway ready endpoint", async () => {
    const { collectDependencyHealth } = await import("./dependency-health");

    await collectDependencyHealth();

    expect(mockFetch).toHaveBeenCalledWith(
      "https://realtime.example.com/readyz",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("honors a longer realtime gateway timeout for cold starts", async () => {
    jest.useFakeTimers();
    mockFetch.mockImplementation(
      () =>
        new Promise<Response>(resolve => {
          setTimeout(() => {
            resolve(
              new Response(JSON.stringify({ runtimeMode: "realtimeGateway" }), {
                status: 200,
              })
            );
          }, 6_000);
        })
    );

    const { collectDependencyHealth } = await import("./dependency-health");

    const snapshotPromise = collectDependencyHealth({
      timeouts: { realtime_gateway: 7_000 },
    });
    await jest.advanceTimersByTimeAsync(6_000);
    const snapshot = await snapshotPromise;

    expect(snapshot.dependencies.realtime_gateway).toEqual(
      expect.objectContaining({
        status: "degraded",
        latencyMs: 6_000,
      })
    );
    expect(snapshot.dependencies.realtime_gateway.reason).toBeUndefined();
  });

  it("uses the server Meta app ID for the Graph dependency probe", async () => {
    process.env.META_APP_ID = "server-app";
    process.env.NEXT_PUBLIC_META_APP_ID = "public-app";
    process.env.META_APP_SECRET = "server-secret";
    mockGetRealtimeGatewayUrl.mockReturnValue("");
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ access_token: "app-access-token" }), {
        status: 200,
      })
    );

    const { collectDependencyHealth } = await import("./dependency-health");

    const snapshot = await collectDependencyHealth();

    expect(snapshot.dependencies.meta_graph_api.status).toBe("healthy");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("client_id=server-app"),
      expect.objectContaining({ method: "GET" })
    );
    expect(mockFetch).not.toHaveBeenCalledWith(
      expect.stringContaining("client_id=public-app"),
      expect.anything()
    );
  });

  it("reports missing Meta credentials without probing Graph", async () => {
    mockGetRealtimeGatewayUrl.mockReturnValue("");

    const { collectDependencyHealth } = await import("./dependency-health");

    const snapshot = await collectDependencyHealth();

    expect(snapshot.dependencies.meta_graph_api).toEqual({
      name: "meta_graph_api",
      status: "not_configured",
      reason: "missing_meta_app_credentials",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

export {};
